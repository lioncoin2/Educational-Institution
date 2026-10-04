/**
 * P8.2 — generator preflight. READ-ONLY connectivity/path validation; it never
 * generates load (no media participants, no sustained traffic). It checks that
 * an off-box generator can reach and authenticate to the staging public
 * interfaces, and prints a PASS/FAIL table with every secret redacted.
 *
 * The pure aggregation/rendering is separated from the network probes so the
 * logic is unit-testable with injected results.
 */
import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';
import { promisify } from 'node:util';

import { RoomServiceClient } from 'livekit-server-sdk';

import { redact, redactSecret } from '../core/redact';
import { checkHttpsUrl, checkWssUrl, livekitApiUrl } from '../core/urls';
import { loadLivekitEnv } from './tokens';

const run = promisify(execFile);

export interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  /** 'warn' marks a soft issue (e.g. local target) that does not fail preflight. */
  readonly level: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

export interface PreflightInput {
  readonly apiBase: string | null;
  readonly livekitUrl: string | null;
  readonly env: NodeJS.ProcessEnv;
}

const ok = (name: string, detail: string): CheckResult => ({
  name,
  pass: true,
  level: 'ok',
  detail,
});
const warn = (name: string, detail: string): CheckResult => ({
  name,
  pass: true,
  level: 'warn',
  detail,
});
const fail = (name: string, detail: string): CheckResult => ({
  name,
  pass: false,
  level: 'fail',
  detail,
});

/** Env presence — reports which LOADTEST_* vars are set, values redacted. */
export function checkEnv(env: NodeJS.ProcessEnv): CheckResult[] {
  const lk = loadLivekitEnv(env);
  const out: CheckResult[] = [];
  out.push(
    lk
      ? ok(
          'env: livekit',
          `url set, key ${redactSecret(env.LOADTEST_LIVEKIT_API_KEY)}, secret ${redactSecret(env.LOADTEST_LIVEKIT_API_SECRET)}`,
        )
      : fail('env: livekit', 'set LOADTEST_LIVEKIT_URL / _API_KEY / _API_SECRET'),
  );
  const apiReady = Boolean(
    env.LOADTEST_API_BASE && env.LOADTEST_API_IDENTIFIER && env.LOADTEST_API_PASSWORD,
  );
  out.push(
    apiReady
      ? ok('env: api', `base set, identifier ${redactSecret(env.LOADTEST_API_IDENTIFIER)}`)
      : warn('env: api', 'LOADTEST_API_* unset (needed only for API-plane load)'),
  );
  return out;
}

/** URL shapes + off-box warning if the target is local. */
export function checkUrls(apiBase: string | null, livekitUrl: string | null): CheckResult[] {
  const out: CheckResult[] = [];
  const wss = checkWssUrl(livekitUrl);
  out.push(
    wss.ok
      ? ok('url: livekit', `wss host ${wss.host}`)
      : fail('url: livekit', wss.problems.join('; ')),
  );
  if (wss.ok && wss.isLocal)
    out.push(warn('url: livekit local', 'targets a local/private host — not an off-box run'));
  if (apiBase !== null) {
    const https = checkHttpsUrl(apiBase);
    out.push(
      https.ok
        ? ok('url: api', `https host ${https.host}`)
        : fail('url: api', https.problems.join('; ')),
    );
    if (https.ok && https.isLocal)
      out.push(warn('url: api local', 'targets a local/private host — not an off-box run'));
  }
  return out;
}

async function dnsCheck(label: string, host: string): Promise<CheckResult> {
  try {
    const { address } = await lookup(host);
    return ok(`dns: ${label}`, `${host} → ${address}`);
  } catch (e) {
    return fail(`dns: ${label}`, `cannot resolve ${host}: ${(e as Error).message}`);
  }
}

async function tlsCheck(host: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port: 443, servername: host, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
      socket.end();
      if (!validTo) return resolve(fail('tls: cert', 'no peer certificate'));
      const days = Math.round((validTo.getTime() - Date.now()) / 86_400_000);
      resolve(
        days > 0
          ? ok('tls: cert', `valid, ${days}d left`)
          : fail('tls: cert', `expired ${-days}d ago`),
      );
    });
    socket.on('error', (e: Error) => resolve(fail('tls: cert', e.message)));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(fail('tls: cert', 'timeout'));
    });
  });
}

async function httpGet(
  url: string,
): Promise<{ status: number; date: string | null; body: string }> {
  const res = await fetch(url, { redirect: 'manual' });
  return {
    status: res.status,
    date: res.headers.get('date'),
    body: (await res.text()).slice(0, 64),
  };
}

async function apiHealthCheck(apiBase: string): Promise<CheckResult> {
  try {
    const r = await httpGet(`${apiBase}/health/ready`);
    return r.status === 200
      ? ok('api: /health/ready', 'HTTP 200')
      : fail('api: /health/ready', `HTTP ${r.status}`);
  } catch (e) {
    return fail('api: /health/ready', (e as Error).message);
  }
}

async function livekitHealthCheck(wssUrl: string): Promise<CheckResult> {
  try {
    const r = await httpGet(livekitApiUrl(wssUrl));
    const good = r.status === 200 && r.body.trim().startsWith('OK');
    return good
      ? ok('livekit: health', 'HTTP 200 OK')
      : fail('livekit: health', `HTTP ${r.status} "${r.body.trim()}"`);
  } catch (e) {
    return fail('livekit: health', (e as Error).message);
  }
}

async function livekitAuthAndRoomCheck(wssUrl: string): Promise<CheckResult[]> {
  const env = loadLivekitEnv();
  if (!env) return [fail('livekit: auth', 'no livekit env')];
  const svc = new RoomServiceClient(livekitApiUrl(wssUrl), env.apiKey, env.apiSecret);
  const out: CheckResult[] = [];
  try {
    await svc.listRooms();
    out.push(ok('livekit: auth', 'RoomService accepted the API key/secret'));
  } catch (e) {
    out.push(fail('livekit: auth', redact((e as Error).message)));
    return out;
  }
  const probe = `loadtest-preflight-${Date.now()}`;
  try {
    await svc.createRoom({ name: probe, emptyTimeout: 10 });
    await svc.deleteRoom(probe);
    out.push(ok('livekit: room create/delete', `created+deleted ${probe}`));
  } catch (e) {
    out.push(fail('livekit: room create/delete', redact((e as Error).message)));
  }
  return out;
}

/** A STUN Binding Request to TURN/UDP 3478; a Binding Success proves reachability. */
async function stunCheck(host: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0); // Binding Request
    req.writeUInt16BE(0x0000, 2); // length
    req.writeUInt32BE(0x2112a442, 4); // magic cookie
    for (let i = 8; i < 20; i += 1) req[i] = Math.floor(Math.random() * 256);
    const timer = setTimeout(() => {
      socket.close();
      resolve(
        warn('turn/udp: 3478 (STUN)', 'no STUN response (UDP may be filtered on this network)'),
      );
    }, 3000);
    socket.on('message', (msg) => {
      clearTimeout(timer);
      socket.close();
      const isSuccess = msg.length >= 2 && msg.readUInt16BE(0) === 0x0101;
      resolve(
        isSuccess
          ? ok('turn/udp: 3478 (STUN)', 'Binding Success')
          : warn('turn/udp: 3478 (STUN)', 'unexpected reply'),
      );
    });
    socket.on('error', (e: Error) => {
      clearTimeout(timer);
      socket.close();
      resolve(warn('turn/udp: 3478 (STUN)', e.message));
    });
    socket.send(req, 3478, host);
  });
}

function clockCheck(dateHeader: string | null): CheckResult {
  if (!dateHeader) return warn('clock: skew', 'no server Date header to compare');
  const skewSec = Math.abs(Date.now() - new Date(dateHeader).getTime()) / 1000;
  return skewSec < 60
    ? ok('clock: skew', `${Math.round(skewSec)}s vs server`)
    : fail('clock: skew', `${Math.round(skewSec)}s — token nbf/exp may break`);
}

async function versionCheck(): Promise<CheckResult> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { timeout: 3000 });
    return ok('generator: version', `commit ${stdout.trim()}`);
  } catch {
    return warn('generator: version', 'git commit unknown');
  }
}

/** Runs every probe. Read-only; generates no load. */
export async function runPreflight(input: PreflightInput): Promise<CheckResult[]> {
  const results: CheckResult[] = [
    ...checkEnv(input.env),
    ...checkUrls(input.apiBase, input.livekitUrl),
  ];
  const wss = checkWssUrl(input.livekitUrl);
  const https = input.apiBase ? checkHttpsUrl(input.apiBase) : null;
  let serverDate: string | null = null;

  if (https?.ok && https.host) {
    results.push(await dnsCheck('api', https.host));
    results.push(await tlsCheck(https.host));
    results.push(await apiHealthCheck(input.apiBase as string));
    try {
      serverDate = (await httpGet(`${input.apiBase as string}/health/ready`)).date;
    } catch {
      /* already reported by apiHealthCheck */
    }
  }
  if (wss.ok && wss.host) {
    results.push(await dnsCheck('livekit', wss.host));
    if (!https?.ok) results.push(await tlsCheck(wss.host));
    results.push(await livekitHealthCheck(input.livekitUrl as string));
    results.push(...(await livekitAuthAndRoomCheck(input.livekitUrl as string)));
    results.push(await stunCheck(wss.host));
  }
  results.push(clockCheck(serverDate));
  results.push(await versionCheck());
  return results;
}

export interface PreflightSummary {
  readonly pass: boolean;
  readonly oks: number;
  readonly warns: number;
  readonly fails: number;
}

export function summarize(results: readonly CheckResult[]): PreflightSummary {
  const oks = results.filter((r) => r.level === 'ok').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  const fails = results.filter((r) => r.level === 'fail').length;
  return { pass: fails === 0, oks, warns, fails };
}

/** PASS/FAIL table, secrets redacted. Pure. */
export function renderTable(results: readonly CheckResult[]): string {
  const icon = (r: CheckResult) =>
    r.level === 'ok' ? 'PASS' : r.level === 'warn' ? 'WARN' : 'FAIL';
  const width = Math.max(...results.map((r) => r.name.length), 10);
  const rows = results.map((r) => `  ${icon(r)}  ${r.name.padEnd(width)}  ${redact(r.detail)}`);
  const s = summarize(results);
  return [
    'Preflight (read-only — no load generated)',
    ...rows,
    '',
    `  ${s.pass ? 'PREFLIGHT PASS' : 'PREFLIGHT FAIL'} — ${s.oks} ok, ${s.warns} warn, ${s.fails} fail`,
  ].join('\n');
}
