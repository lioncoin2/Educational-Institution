/**
 * P8.4 — the operator entry for ONE off-box rung (design §14). Runs on the SUT
 * (the credential authority) and generates no media itself. DRY-RUN by default:
 * prints the plan and every cap check. A real rung needs `--allow-load`, a
 * `--target`, at least one SSH generator, the SUT env file, and zero cap
 * violations. It never chains rungs and never retries.
 *
 *   npx ts-node test/load/cli/fleet-run.ts --rung S1 --generators gen-1.example \
 *     --target wss://livekit-staging.adlink4.com --ice turn-free --allow-load
 *   npx ts-node test/load/cli/fleet-run.ts cleanup --run <runId> --target wss://…
 *
 * Exit codes: 0 GREEN (or a clean dry-run), 2 refused, 3 YELLOW, 5 RED, 6 UNKNOWN.
 */
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { type FleetPlan, parseFleetArgs, planFleetRun } from '../fleet/fleet-args';
import { previousOf, prerequisiteProblems } from '../fleet/prerequisites';
import { VALIDATED_DENSITY } from '../core/safety';
import { readFleetEnv } from '../livekit/credentials';
import { roomOps } from '../livekit/room-ops';
import { mintScopedTicket } from '../livekit/tokens';
import { EventCsv } from '../mp/csv';
import { ProcessManager } from '../mp/process-manager';
import { systemReaders } from '../observe/host-base';
import { countTicketLines } from '../observe/access-log';
import { createLivekitLogAnalyzer, readLivekitLog } from '../observe/livekit-log';
import { SUT_DEFAULTS, SutSampler } from '../observe/sut-sampler';
import { type RungResult } from '../results/schema';
import { writeRungEvidence } from '../results/writer';
import { cleanupRun } from '../fleet/cleanup';
import { runRung } from '../fleet/controller';
import { type SshEndpoint, sshCommandSpec } from '../fleet/endpoints';
import { newRunId, planShards, roomFor } from '../fleet/shards';

const run = promisify(execFile);
const DEFAULTS = {
  envFile: '/opt/Educational-Institution/infra/env/staging.env',
  sshKey: '/root/.ssh/p84_generator_ed25519',
  knownHosts: '/root/.ssh/p84_known_hosts',
  sshUser: 'p84',
  sutAddress: '213.136.65.135',
  udpPort: 7882,
  accessLog: '/var/log/nginx/access.log',
  out: '/var/lib/p84/results',
} as const;
const EXIT = { GREEN: 0, YELLOW: 3, RED: 5, UNKNOWN: 6 } as const;

function render(p: FleetPlan): string {
  const r = p.rung;
  const shards =
    r && p.generators.length > 0
      ? planShards({
          runId: '0000000000000000',
          participants: r.participants,
          hosts: p.generators.length,
          density: p.density,
        })
      : null;
  return [
    '──────────────────── P8.4 FLEET RUNG ────────────────────',
    `MODE        : ${p.allowLoad && p.errors.length === 0 ? 'REAL LOAD (off-box)' : 'DRY-RUN'}`,
    `RUNG        : ${r ? `${r.id} — ${r.participants} participants (1 audio publisher + ${r.participants - 1} visible listeners), hold ${r.holdSeconds} s` : '(none)'}`,
    `PATH        : A (SFU-direct, loadtest- room), 1 room`,
    `ICE         : ${p.ice === 'turn-free' ? 'TURN-free (explicit STUN-only list, direct UDP)' : 'FORCED RELAY — S1 positive control only (never a capacity claim)'}`,
    `RAMP        : ${p.ramp}/s global (controller-paced, just-in-time tickets)`,
    `GENERATORS  : ${p.generators.join(', ') || '(none)'}`,
    `DENSITY     : ${p.density} participants/worker process${p.calibration ? ' (CALIBRATION run)' : ''}`,
    `SHARDS      : ${shards ? `${shards.listeners.length + 1} worker processes` : '-'}`,
    `TARGET      : ${p.target ?? '(none)'}`,
    p.errors.length > 0
      ? `REFUSED     :\n${p.errors.map((e) => `  - ${e}`).join('\n')}`
      : '─────────────────────────────────────────────────────────',
  ].join('\n');
}

async function provenDensity(path: string | undefined): Promise<number> {
  if (!path) return VALIDATED_DENSITY;
  const r = JSON.parse(await readFile(path, 'utf8')) as {
    verdict?: { class?: string };
    meta?: { calibration?: { density?: number } | null };
  };
  const d = r.meta?.calibration?.density;
  if (r.verdict?.class !== 'GREEN' || typeof d !== 'number')
    throw new Error('--density-evidence must be a GREEN calibration result');
  return d;
}

/** This run's ticket lines from generator IPs, across the live log and its rotation; null if unreadable. */
async function ticketLeaks(ips: readonly string[], sinceMs: number): Promise<number | null> {
  const [live, rotated] = await Promise.all(
    [DEFAULTS.accessLog, `${DEFAULTS.accessLog}.1`].map((p) =>
      readFile(p, 'utf8').catch(() => null),
    ),
  );
  if (live === null) return null;
  return [live, rotated].reduce(
    (n, text) => n + (text === null ? 0 : countTicketLines(text, ips, sinceMs)),
    0,
  );
}

async function dbRows(): Promise<number | null> {
  try {
    const { stdout } = await run('docker', [
      'exec',
      'institution-db-1',
      'psql',
      '-U',
      'institution',
      '-d',
      'institution',
      '-tAc',
      "select count(*) from users where id like 'p84-%'",
    ]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function commit(): Promise<string> {
  return (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
}

/** `ssh … <verb> <runId>` on every generator through the dispatcher; `fetch` output goes to a tar file. */
async function onGenerators(
  endpoints: readonly SshEndpoint[],
  verb: 'fetch' | 'stop',
  runId: string,
  outDir: string | null,
): Promise<string[]> {
  const pm = new ProcessManager();
  const files: string[] = [];
  endpoints.forEach((e, i) => {
    const proc = pm.spawn(i, sshCommandSpec(e, verb, runId, process.env));
    if (verb === 'fetch' && outDir && proc.child.stdout) {
      const file = join(outDir, `generator-${e.host}.tar`);
      proc.child.stdout.pipe(createWriteStream(file, { mode: 0o600 }));
      files.push(file);
    } else {
      proc.child.stdout?.resume();
    }
    proc.child.stdin?.end();
  });
  await pm.waitAllExited(120_000);
  return files;
}

function endpointsOf(hosts: readonly string[], v: ReadonlyMap<string, string>): SshEndpoint[] {
  return hosts.map((host) => ({
    kind: 'ssh',
    host,
    user: v.get('ssh-user') ?? DEFAULTS.sshUser,
    keyPath: v.get('ssh-key') ?? DEFAULTS.sshKey,
    knownHostsPath: v.get('known-hosts') ?? DEFAULTS.knownHosts,
  }));
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseFleetArgs(argv);
  const values = args.values;
  if (args.command === 'cleanup') {
    if (args.errors.length > 0) {
      process.stderr.write(`refused:\n${args.errors.map((e) => `  - ${e}`).join('\n')}\n`);
      return 2;
    }
    return cleanupCommand(values);
  }
  let proven: number;
  try {
    proven = await provenDensity(values.get('density-evidence'));
  } catch (e) {
    process.stderr.write(`${String((e as Error)?.message ?? e)}\n`);
    return 2;
  }
  const planned = planFleetRun(args, proven);
  const previousPath = values.get('previous');
  const previous = previousPath
    ? previousOf(JSON.parse(await readFile(previousPath, 'utf8')) as RungResult)
    : null;
  const plan: FleetPlan = planned.rung
    ? {
        ...planned,
        errors: [
          ...planned.errors,
          ...prerequisiteProblems(
            planned.rung,
            planned.ice,
            previous,
            args.flags.has('accept-yellow'),
          ),
        ],
      }
    : planned;
  process.stdout.write(`${render(plan)}\n`);
  if (plan.errors.length > 0 || !plan.rung) return 2;
  if (!plan.allowLoad) {
    process.stdout.write(
      '\nDry-run only — no load generated. Add --allow-load to run this rung.\n',
    );
    return 0;
  }
  if (!plan.target || plan.generators.length === 0) {
    process.stderr.write('real load needs --target and at least one --generators host\n');
    return 2;
  }
  const env = await readFleetEnv(values.get('env-file') ?? DEFAULTS.envFile, plan.target);
  const runId = newRunId();
  const outDir = join(values.get('out') ?? DEFAULTS.out, runId);
  const room = roomFor(runId);
  const endpoints = endpointsOf(plan.generators, values);
  const csv = new EventCsv(join(outDir, 'events.csv'));
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await csv.start();
  const sut = new SutSampler(systemReaders(), {
    ...SUT_DEFAULTS,
    runId,
    rung: plan.rung.id,
    harnessPids: [{ pid: process.pid, role: 'controller' }],
  });
  process.stdout.write(`\nrunId ${runId} — room ${room}\n`);
  const outcome = await runRung(
    {
      runId,
      rung: plan.rung,
      rampPerSecond: plan.ramp,
      density: plan.density,
      ice: plan.ice,
      calibration: plan.calibration,
      sutAddress: values.get('sut-address') ?? DEFAULTS.sutAddress,
      udpPort: DEFAULTS.udpPort,
    },
    {
      endpoints,
      pm: new ProcessManager(),
      parentEnv: process.env,
      commit: await commit(),
      rooms: roomOps(env),
      mint: (identity, role) => mintScopedTicket(env, { identity, room, role }),
      sut,
      dbRows,
      postRung: async (w) => {
        // A generator IP never legitimately sends access_token= (rtc-node uses a header): any line is a leak.
        const leaks = await ticketLeaks(w.generatorIps, w.sinceMs);
        const analyzer = createLivekitLogAnalyzer({
          room: w.room,
          identityPrefix: w.identityPrefix,
        });
        const since = new Date(w.sinceMs).toISOString();
        const until = new Date(w.untilMs).toISOString();
        for await (const line of readLivekitLog(SUT_DEFAULTS.livekitContainer, since, until))
          analyzer.add(line);
        return {
          log: analyzer.counts(),
          ticketLeaks: leaks,
        };
      },
      csv,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
  );
  const fetched = await onGenerators(endpoints, 'fetch', runId, outDir);
  const file = await writeRungEvidence(outDir, outcome.result, outcome.samples, [
    join(outDir, 'events.csv'),
    ...fetched,
  ]);
  const v = outcome.result.verdict;
  process.stdout.write(
    `\nVERDICT ${v.class}${v.failureClass ? ` (class ${v.failureClass})` : ''}\n${v.reasons.map((r) => `  - ${r}`).join('\n')}\nresult: ${file}\n`,
  );
  const t = outcome.result.cleanup.teardown;
  if (t.cleaned !== t.workers && (v.class === 'GREEN' || v.class === 'YELLOW')) {
    // P8.3.8: an unclean teardown is never reported as success.
    process.stderr.write(
      `TEARDOWN NOT CLEAN: cleaned=${t.cleaned}/${t.workers} timedOut=${t.timedOut} exitedUnclean=${t.exitedUnclean} forced=${t.forced}\n`,
    );
    return EXIT.UNKNOWN;
  }
  return EXIT[v.class];
}

/** Emergency cleanup (design §20): stop generators by recorded PIDs, delete the room, verify. */
async function cleanupCommand(v: ReadonlyMap<string, string>): Promise<number> {
  const runId = v.get('run');
  const target = v.get('target');
  if (!runId || !/^[0-9a-f]{16}$/.test(runId) || !target) {
    process.stderr.write('cleanup needs --run <16-hex runId> and --target\n');
    return 2;
  }
  const generators = (v.get('generators') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  await onGenerators(endpointsOf(generators, v), 'stop', runId, null);
  const env = await readFleetEnv(v.get('env-file') ?? DEFAULTS.envFile, target);
  const sut = new SutSampler(systemReaders(), {
    ...SUT_DEFAULTS,
    runId,
    rung: 'cleanup',
    harnessPids: [],
  });
  const report = await cleanupRun(
    {
      rooms: roomOps(env),
      dbRows,
      sutSample: () => sut.sample(),
      sleep: async () => undefined,
      now: Date.now,
    },
    {
      room: roomFor(runId),
      baseline: null,
      generatorProcesses: {},
      closedAt: Date.now(),
      recoveryWaitMs: 0,
      recheckMs: 0,
    },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.verified ? 0 : 5;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`fleet-run: ${String((e as Error)?.message ?? e)}\n`);
      process.exitCode = 2;
    },
  );
}
