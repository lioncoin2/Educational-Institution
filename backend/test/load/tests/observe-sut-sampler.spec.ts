import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { samplerSanity } from '../observe/derive';
import { quietReaders } from '../observe/quiet-readers';
import { SAMPLE_SCHEMA } from '../observe/sample';
import {
  parseInspect,
  parseWorkerConnections,
  SUT_DEFAULTS,
  SutSampler,
  type SutSamplerOptions,
} from '../observe/sut-sampler';
import { FAILING, FakeHost, nullPaths, type Patch, patched } from './support/fake-host';

// ---------------------------------------------------------------------------
// sut-sampler
// ---------------------------------------------------------------------------

describe('observe/sut-sampler — pure helpers', () => {
  it('parseInspect: strips the leading /, reads pid/restarts/health, skips other lines', () => {
    expect(
      parseInspect(
        '/institution-livekit-1 4242 2 healthy\n\n/institution-db-1 0 0 none\nnot a line\n',
      ),
    ).toEqual([
      { name: 'institution-livekit-1', pid: 4242, restarts: 2, health: 'healthy' },
      { name: 'institution-db-1', pid: 0, restarts: 0, health: 'none' },
    ]);
    expect(parseInspect('')).toEqual([]);
  });

  it('parseWorkerConnections: the live directive (Ubuntu layout), commented ones ignored', () => {
    const ubuntu =
      'user www-data;\nworker_processes auto;\npid /run/nginx.pid;\n\n' +
      'events {\n\tworker_connections 768;\n\t# multi_accept on;\n}\n';
    expect(parseWorkerConnections(ubuntu)).toBe(768);
    expect(
      parseWorkerConnections(
        '#worker_connections 1024;\nevents {\n    # worker_connections 512;\n    worker_connections 40960;\n}\n',
      ),
    ).toBe(40_960);
    expect(parseWorkerConnections('events {\n}\n')).toBeNull();
    expect(parseWorkerConnections('events {\n  worker_connections ;\n}\n')).toBeNull();
  });

  it('parseWorkerConnections: reads the one-line events block of the S-2 change (design §15)', () => {
    // Regression: a line-start anchor once parsed the design's own S-2 form
    // `events { worker_connections 40960; }` as null → sut.nginx null → V-sampler.
    const s2 =
      'worker_rlimit_nofile 65536;\n' +
      'events { worker_connections 40960; } # 10k worst case 21,117 = 52%\n';
    expect(parseWorkerConnections(s2)).toBe(40_960);
  });
});

describe('observe/sut-sampler — SutSampler (SUT)', () => {
  const servers: Server[] = [];
  let ok200 = '';
  let lk406 = '';
  let silent = '';

  async function serve(status: number): Promise<{ server: Server; url: string }> {
    const server = createServer((_req, res) => {
      res.statusCode = status;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
  }

  const close = (server: Server): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  beforeAll(async () => {
    const a = await serve(200);
    const b = await serve(406);
    servers.push(a.server, b.server);
    ok200 = a.url;
    lk406 = b.url;
    const gone = await serve(200);
    silent = gone.url; // nothing listens here once it is closed
    await close(gone.server);
  });

  afterAll(async () => {
    await Promise.all(servers.map(close));
  });

  /** quietReaders' docker answer reports this test process's PID as the LiveKit container's. */
  const LK = process.pid;
  const CONTROLLER = process.pid === 4300 ? 4301 : 4300;
  const LOG = '/fake/nginx/error.log';

  const sutHost = (): FakeHost =>
    new FakeHost({
      [LK]: {
        comm: 'livekit-server',
        ppid: 1,
        pgrp: LK,
        utime: 9_000,
        stime: 1_000,
        rssKb: 600_000,
        threads: 30,
        fds: 700,
      },
      [CONTROLLER]: {
        comm: 'node',
        ppid: 1,
        pgrp: CONTROLLER,
        utime: 300,
        stime: 100,
        rssKb: 120_000,
        threads: 12,
        fds: 40,
      },
    });

  const opts = (url: string, o: Partial<SutSamplerOptions> = {}): SutSamplerOptions => ({
    ...SUT_DEFAULTS,
    livekitHealthUrl: url,
    runId: 'run-p84',
    rung: 'S2',
    harnessPids: [{ pid: CONTROLLER, role: 'controller' }],
    ...o,
  });

  it('builds a complete SUT sample: no null section, sane as a series', async () => {
    let now = 10_000;
    const sampler = new SutSampler(
      quietReaders(sutHost(), { role: 'sut' }),
      opts(ok200),
      () => now,
    );
    const first = await sampler.sample();
    now = 15_000;
    const second = await sampler.sample();

    expect(nullPaths(first)).toEqual(['clockOffsetMs', 'gen']);
    expect(nullPaths(second)).toEqual(['clockOffsetMs', 'gen']);
    expect(first).toMatchObject({
      schema: SAMPLE_SCHEMA,
      runId: 'run-p84',
      rung: 'S2',
      host: 'sut',
      role: 'sut',
      t: 10_000,
      seq: 1,
    });
    expect(second).toMatchObject({ t: 15_000, seq: 2 });
    expect(first.sut).toEqual({
      relaySockets: 0,
      turnTlsEstab: 0,
      fwNewFlows: { udp3478: 40, udp7882: 20 },
      containers: SUT_DEFAULTS.containers.map((name) => ({ name, restarts: 0, health: 'healthy' })),
      livekitHttp: 200,
      nginx: {
        workerConnections: 768,
        workerFds: [50, 50],
        errorWorkerConnections: 0,
        errorUpstream: 0,
      },
    });
    expect(first.procs).toEqual([
      { pid: LK, role: 'livekit', cpuTicks: 10_000, rssKb: 600_000, fds: 700, threads: 30 },
      { pid: CONTROLLER, role: 'controller', cpuTicks: 400, rssKb: 120_000, fds: 40, threads: 12 },
    ]);
    expect(samplerSanity([first, second])).toEqual([]);
  });

  it('LiveKit health: 406 is reported as 406; no answer is null, not 0', async () => {
    const r = quietReaders(sutHost(), { role: 'sut' });
    expect((await new SutSampler(r, opts(lk406)).sample()).sut?.livekitHttp).toBe(406);
    expect((await new SutSampler(r, opts(silent)).sample()).sut?.livekitHttp).toBeNull();
  });

  it('finds LiveKit by the container PID from docker inspect — never by a process name', async () => {
    const host = new FakeHost({
      4242: {
        comm: 'server',
        ppid: 4200,
        pgrp: 4242,
        utime: 7_000,
        stime: 3_000,
        rssKb: 800_000,
        threads: 40,
        fds: 900,
      },
      // a decoy whose NAME says livekit; it is not the container's PID
      5555: { comm: 'livekit-server', ppid: 1, pgrp: 5555, utime: 1, rssKb: 1, fds: 1 },
      4300: { comm: 'node', ppid: 1, pgrp: 4300, utime: 1, rssKb: 1 },
    });
    const inspect =
      '/institution-api-1 3100 0 healthy\n/institution-livekit-1 4242 2 healthy\n' +
      '/institution-redis-1 3300 0 none\n/institution-db-1 3400 1 healthy\n';
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const r = patched(
      quietReaders(host, { role: 'sut' }),
      { cmd: (file) => (file === 'docker' ? inspect : undefined) },
      calls,
    );
    const s = await new SutSampler(
      r,
      opts(ok200, { harnessPids: [{ pid: 4300, role: 'controller' }] }),
    ).sample();

    expect(s.procs.map((p) => [p.pid, p.role])).toEqual([
      [4242, 'livekit'],
      [4300, 'controller'],
    ]);
    expect(s.procs[0]).toMatchObject({ cpuTicks: 10_000, rssKb: 800_000, fds: 900, threads: 40 });
    expect(host.fileReads.filter((p) => p.startsWith('/proc/5555/'))).toEqual([]);
    expect(host.pidsCalls).toBe(0);
    expect(calls.find((c) => c.file === 'docker')?.args).toEqual([
      'inspect',
      '-f',
      expect.stringContaining('{{.State.Pid}}'),
      ...SUT_DEFAULTS.containers,
    ]);
    expect(s.sut?.containers).toEqual([
      { name: 'institution-api-1', restarts: 0, health: 'healthy' },
      { name: 'institution-livekit-1', restarts: 2, health: 'healthy' },
      { name: 'institution-redis-1', restarts: 0, health: 'none' },
      { name: 'institution-db-1', restarts: 1, health: 'healthy' },
    ]);
  });

  it('a stopped LiveKit container (pid 0) has no LiveKit process and no fallback lookup', async () => {
    const host = sutHost();
    const inspect = SUT_DEFAULTS.containers.map((n) => `/${n} 0 1 none`).join('\n');
    const r = patched(quietReaders(host, { role: 'sut' }), {
      cmd: (file) => (file === 'docker' ? inspect : undefined),
    });
    const s = await new SutSampler(r, opts(ok200)).sample();
    expect(s.procs.map((p) => p.role)).toEqual(['controller']);
    expect(host.fileReads.some((p) => p.startsWith('/proc/0/'))).toBe(false);
    expect(host.pidsCalls).toBe(0);
  });

  describe('nginx error log and baseline()', () => {
    const WC = '2026/10/04 10:00:01 [alert] 1201#1201: 768 worker_connections are not enough\n';
    const UP =
      '2026/10/04 10:00:02 [error] 1202#1202: *7 upstream timed out (110: Connection timed out) ' +
      'while reading response header from upstream, client: 203.0.113.8, upstream: "http://127.0.0.1:7880/rtc"\n';

    it('without a baseline every matching line counts', async () => {
      const host = sutHost();
      host.files.set(LOG, WC + WC + UP);
      const s = await new SutSampler(
        quietReaders(host, { role: 'sut' }),
        opts(ok200, { nginxErrorLog: LOG }),
      ).sample();
      expect(s.sut?.nginx).toMatchObject({ errorWorkerConnections: 2, errorUpstream: 1 });
    });

    it('baseline() makes earlier lines not count; later lines do', async () => {
      const host = sutHost();
      host.files.set(LOG, WC + WC + UP);
      const sampler = new SutSampler(
        quietReaders(host, { role: 'sut' }),
        opts(ok200, { nginxErrorLog: LOG }),
      );
      await sampler.baseline();
      expect((await sampler.sample()).sut?.nginx).toMatchObject({
        errorWorkerConnections: 0,
        errorUpstream: 0,
      });
      host.files.set(LOG, WC + WC + UP + WC);
      expect((await sampler.sample()).sut?.nginx).toMatchObject({
        errorWorkerConnections: 1,
        errorUpstream: 0,
      });
      host.files.set(LOG, WC + WC + UP + WC + UP);
      expect((await sampler.sample()).sut?.nginx).toMatchObject({
        errorWorkerConnections: 1,
        errorUpstream: 1,
      });
    });

    it('a line logged after the baseline still counts when the log was rotated (shorter file)', async () => {
      // Regression: the baseline was once a character offset into the old file; after logrotate
      // the fresh error.log is shorter than that offset, so slice() dropped every new line.
      const host = sutHost();
      host.files.set(LOG, WC + WC + UP);
      const sampler = new SutSampler(
        quietReaders(host, { role: 'sut' }),
        opts(ok200, { nginxErrorLog: LOG }),
      );
      await sampler.baseline();
      host.files.set(LOG, WC);
      expect((await sampler.sample()).sut?.nginx?.errorWorkerConnections).toBe(1);
    });
  });

  it('nginx workers are the exact children of the pid-file master (another parent is skipped)', async () => {
    const host = sutHost();
    host.procs.set(999_993, { comm: 'nginx', ppid: 1, pgrp: 999_993, fds: 70 });
    const r = quietReaders(host, {
      role: 'sut',
      files: {
        '/proc/999990/task/999990/children': '999991 999992 999993\n',
        '/etc/nginx/nginx.conf': 'events {\n    worker_connections 40960;\n}\n',
      },
    });
    const s = await new SutSampler(r, opts(ok200)).sample();
    expect(s.sut?.nginx).toMatchObject({ workerConnections: 40_960, workerFds: [50, 50] });
  });

  it('every reader failing yields null sections and no processes — never a zero', async () => {
    const s = await new SutSampler(FAILING, opts(silent), () => 7).sample();
    expect(nullPaths(s).sort()).toEqual(
      [
        'clockOffsetMs',
        'cores',
        'cpuClockMs',
        'load1',
        'mem',
        'oomKills',
        'net',
        'qdisc',
        'udp.v4',
        'udp.v6',
        'softnet',
        'conntrack',
        'udpSockets',
        'sut.relaySockets',
        'sut.turnTlsEstab',
        'sut.fwNewFlows',
        'sut.containers',
        'sut.livekitHttp',
        'sut.nginx',
        'gen',
      ].sort(),
    );
    expect(s.procs).toEqual([]);
  });

  it.each([
    {
      source: 'ip6tables',
      patch: { cmd: (f: string) => (f === 'ip6tables' ? null : undefined) },
      path: 'sut.fwNewFlows',
    },
    {
      source: 'iptables',
      patch: { cmd: (f: string) => (f === 'iptables' ? null : undefined) },
      path: 'sut.fwNewFlows',
    },
    {
      source: 'docker inspect',
      patch: { cmd: (f: string) => (f === 'docker' ? null : undefined) },
      path: 'sut.containers',
    },
    {
      source: 'relay-range ss',
      patch: {
        cmd: (f: string, a: readonly string[]) =>
          f === 'ss' && a.includes('sport >= :30000 and sport <= :32767') ? null : undefined,
      },
      path: 'sut.relaySockets',
    },
    {
      source: 'TURN/TLS ss',
      patch: {
        cmd: (f: string, a: readonly string[]) =>
          f === 'ss' && a.includes('established') ? null : undefined,
      },
      path: 'sut.turnTlsEstab',
    },
    {
      source: 'nginx.conf',
      patch: { files: { '/etc/nginx/nginx.conf': null } },
      path: 'sut.nginx',
    },
    { source: 'nginx pid file', patch: { files: { '/run/nginx.pid': null } }, path: 'sut.nginx' },
    {
      source: 'nginx error log',
      patch: { files: { '/var/log/nginx/error.log': null } },
      path: 'sut.nginx',
    },
  ])('$source unreadable → $path is null (never 0), the rest intact', async ({ patch, path }) => {
    const r = patched(quietReaders(sutHost(), { role: 'sut' }), patch as Patch);
    const s = await new SutSampler(r, opts(ok200)).sample();
    expect(nullPaths(s).sort()).toEqual(['clockOffsetMs', 'gen', path].sort());
    expect(s.procs.map((p) => p.role)).toEqual(
      path === 'sut.containers' ? ['controller'] : ['livekit', 'controller'],
    );
  });
});
