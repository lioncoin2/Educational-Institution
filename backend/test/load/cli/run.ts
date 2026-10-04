/**
 * P8 load harness — CLI entry point.
 *
 *   DRY-RUN IS THE DEFAULT. Nothing connects unless BOTH `--allow-load` and a
 *   `--target` are given AND the scenario passes every safety cap. A dry-run
 *   validates the scenario, prints the plan and the exact target it WOULD hit,
 *   and exits without opening a single socket.
 *
 *   npx ts-node test/load/cli/run.ts --list
 *   npx ts-node test/load/cli/run.ts --scenario lk-listeners-500            # dry-run
 *   npx ts-node test/load/cli/run.ts --scenario lk-listeners-500 \
 *       --target wss://livekit-staging.adlink4.com --allow-load             # real run
 *
 * The real-run path (collector + media/api drivers) is loaded only when the gate
 * says so, so the default path imports no WebRTC client and no network code.
 */
import {
  type HarnessConfig,
  type Scenario,
  applyOverrides,
  customScenario,
  participantsPerRoom,
  readArgs,
  totalParticipants,
  totalPublishers,
  validateScenario,
} from '../core/config';
import { decideGate } from '../core/safety';
import { SCENARIOS, getScenario } from '../scenarios/catalog';

const USAGE = `P8 load harness (dry-run by default)

  --list                       list scenarios and exit
  --help                       this help
  --scenario <id>              a catalog scenario (see --list)
  --kind <api|livekit|combined>  custom scenario plane (when no --scenario)
  --rooms N --listeners N --speakers N --screen N   per-room overrides
  --ramp N --duration N        ramp/second and hold seconds
  --api-connections N --api-rps N
  --relay                      force TURN relay (livekit)
  --target <url>               media/API base (REQUIRED for real load)
  --allow-load                 actually generate load (otherwise dry-run)
  --out <file.csv>             metrics CSV output (real runs)
  --interval <ms>              metrics sample interval (default 2000)

Safety: dry-run is default; real load needs --allow-load AND --target AND a
scenario within the hard caps. There is no --force.`;

export interface Planned {
  readonly config?: HarnessConfig;
  readonly errors: readonly string[];
  readonly text: string;
}

/** Turns argv into a plan + rendered text. Pure (no I/O, no connections). */
export function plan(argv: readonly string[]): Planned {
  const args = readArgs(argv);
  if (args.bools.has('help')) return { errors: [], text: USAGE };
  if (args.bools.has('list')) return { errors: [], text: renderList() };

  const errors: string[] = [...args.bad];
  for (const u of args.unknown) errors.push(`unexpected argument: ${u}`);

  let base: Scenario | undefined;
  const id = args.strings.get('scenario');
  if (id !== undefined) {
    base = getScenario(id);
    if (!base) errors.push(`unknown scenario '${id}' (see --list)`);
  }
  const scenario = base ? applyOverrides(base, args) : customScenario(args);
  errors.push(...validateScenario(scenario));
  if (errors.length > 0) return { errors, text: errors.map((e) => `  - ${e}`).join('\n') };

  const config: HarnessConfig = {
    scenario,
    target: args.strings.get('target') ?? null,
    allowLoad: args.bools.has('allow-load'),
    outCsv: args.strings.get('out') ?? null,
    sampleIntervalMs: args.numbers.get('interval') ?? 2000,
  };
  return { config, errors: [], text: renderPlan(config) };
}

function renderList(): string {
  return ['Scenarios:', ...SCENARIOS.map((s) => `  ${s.id.padEnd(22)} ${s.title}`)].join('\n');
}

export function renderPlan(config: HarnessConfig): string {
  const s = config.scenario;
  const gate = decideGate(config);
  const lines = [
    '────────────────────────────────────────────────────────',
    `Scenario : ${s.id} — ${s.title}`,
    `Plane    : ${s.target}`,
    `Rooms    : ${s.rooms}   participants/room: ${participantsPerRoom(s)}   total: ${totalParticipants(s)}`,
    `Publishers: ${totalPublishers(s)} (speakers ${s.speakersPerRoom}/room, screen ${s.screenSharesPerRoom}/room)`,
    `Relay    : ${s.relay}   ramp: ${s.rampPerSecond}/s   hold: ${s.holdSeconds}s`,
    `API      : ${s.apiConnections} ws conns, ${s.apiRequestsPerSecond} rps`,
    `Traffic  : ${s.expectedTraffic}`,
    `Target   : ${config.target ?? '(none — dry-run)'}`,
    `MODE     : ${gate.mode.toUpperCase()}`,
  ];
  if (gate.mode === 'real-load') {
    lines.push(
      '',
      '  ⚠  REAL LOAD WILL BE GENERATED AGAINST THE TARGET ABOVE  ⚠',
      `  ⚠  ${config.target}  ⚠`,
    );
  }
  if (gate.refusals.length > 0) {
    lines.push('', 'Refused because:', ...gate.refusals.map((r) => `  - ${r}`));
  }
  lines.push('', `Stop conditions: ${s.stopConditions.join('; ')}`);
  lines.push('────────────────────────────────────────────────────────');
  return lines.join('\n');
}

async function runReal(config: HarnessConfig): Promise<number> {
  // Loaded lazily so the default (dry-run) path pulls in no network/WebRTC code.
  const { Collector } = await import('../metrics/collector');
  const s = config.scenario;
  const collector = config.outCsv ? new Collector(config.outCsv) : null;
  if (collector) await collector.start(config.sampleIntervalMs);
  try {
    if (s.target === 'livekit' || s.target === 'combined') {
      const { loadLivekitEnv } = await import('../livekit/tokens');
      const env = loadLivekitEnv();
      if (!env) {
        process.stderr.write('LOADTEST_LIVEKIT_* env not set — refusing media run.\n');
        return 4;
      }
      const { runMediaScenario } = await import('../livekit/media-run');
      const result = await runMediaScenario(s, env);
      process.stdout.write(`media: ${JSON.stringify(result)}\n`);
    }
    if (s.target === 'api' || s.target === 'combined') {
      const { loadApiEnv, runApiScenario } = await import('../api/api-load');
      const env = loadApiEnv();
      if (!env) {
        process.stderr.write('LOADTEST_API_* env not set — refusing api run.\n');
        return 4;
      }
      const result = await runApiScenario(env, {
        connections: s.apiConnections,
        requestsPerSecond: s.apiRequestsPerSecond,
        holdSeconds: s.holdSeconds,
      });
      process.stdout.write(`api: ${JSON.stringify(result)}\n`);
    }
  } finally {
    collector?.stop();
  }
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const planned = plan(argv);
  process.stdout.write(`${planned.text}\n`);
  if (planned.errors.length > 0 || !planned.config) return 2;

  const gate = decideGate(planned.config);
  if (gate.mode === 'refused') return 3;
  if (gate.mode === 'dry-run') {
    process.stdout.write(
      '\nDry-run only — no load generated. Add --allow-load and --target to run.\n',
    );
    return 0;
  }
  return runReal(planned.config);
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
