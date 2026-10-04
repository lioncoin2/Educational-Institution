/**
 * P8.3.5 — multi-process generator CLI. DRY-RUN by default; a real run needs
 * --allow-load AND --target AND a scenario within the safety caps (global +
 * multi-process). Prints an ON-BOX confirmation naming the exact-N gate, then
 * runs the supervisor.
 *
 *   npx ts-node test/load/cli/mp-run.ts --scenario MP_SMOKE \
 *     --target wss://livekit-staging.adlink4.com --allow-load --event-out mp.csv
 *
 * The media/WebRTC code is loaded (in the forked workers) only on a real run.
 */
import {
  type MediaPath,
  type Scenario,
  applyOverrides,
  readArgs,
  totalParticipants,
  validateScenario,
} from '../core/config';
import { checkScenarioSafety } from '../core/safety';
import { getScenario } from '../scenarios/catalog';
import { MP_LIMITS, perWorker, validateMp } from '../mp/partition';

interface Plan {
  readonly scenario?: Scenario;
  readonly workers: number;
  readonly mediaPath: MediaPath;
  readonly target: string | null;
  readonly allowLoad: boolean;
  readonly eventOut: string | null;
  readonly errors: readonly string[];
}

export function buildPlan(argv: readonly string[]): Plan {
  const args = readArgs(argv);
  const errors: string[] = [...args.bad];
  const id = args.strings.get('scenario');
  const base = id ? getScenario(id) : undefined;
  if (id && !base) errors.push(`unknown scenario '${id}' (MP_* via --list)`);
  const scenario = base ? applyOverrides(base, args) : undefined;
  const workers = args.numbers.get('workers') ?? base?.workers ?? 2;
  const mp = (args.strings.get('media-path') as MediaPath) ?? base?.mediaPath ?? 'direct';
  if (mp !== 'direct' && mp !== 'relay') errors.push(`media-path must be direct|relay`);
  if (scenario) {
    errors.push(...validateScenario(scenario));
    errors.push(...checkScenarioSafety(scenario));
    errors.push(...validateMp(totalParticipants(scenario), workers));
  } else if (!id) {
    errors.push('a --scenario is required (e.g. MP_SMOKE)');
  }
  return {
    scenario,
    workers,
    mediaPath: mp,
    target: args.strings.get('target') ?? null,
    allowLoad: args.bools.has('allow-load'),
    eventOut: args.strings.get('event-out') ?? null,
    errors,
  };
}

export function renderConfirmation(p: Plan): string {
  const s = p.scenario;
  if (!s) return `errors:\n${p.errors.map((e) => `  - ${e}`).join('\n')}`;
  const total = totalParticipants(s);
  const mode = p.allowLoad && p.target && p.errors.length === 0 ? 'REAL-LOAD' : 'DRY-RUN';
  return [
    '────────────────────── MP RUN ──────────────────────',
    `MODE               : ON-BOX CAPACITY — NETWORK/INGRESS SOFTIRQ NOT AUTHORITATIVE  [${mode}]`,
    `SUT                : vmi3631989`,
    `GENERATOR          : vmi3631989 (${p.workers} worker processes)`,
    `SCENARIO           : ${s.id} — ${s.title}`,
    `ROOMS              : ${s.rooms}`,
    `PARTICIPANTS       : ${total}  (${s.speakersPerRoom} pub + ${s.listenersPerRoom} listeners/room)`,
    `WORKERS            : ${p.workers}  (~${perWorker(total, p.workers)} participants/worker; cap ${MP_LIMITS.maxParticipantsPerWorker})`,
    `MEDIA PATH         : ${p.mediaPath}${p.mediaPath === 'direct' ? ' (no forced TURN — primary SFU path)' : ' (forced TURN relay — SEPARATE test)'}`,
    `DURATION           : ${s.holdSeconds} s hold`,
    `EXACT GATE         : hold starts only when ${total}/${total} connected AND publisher published; ANY failure aborts`,
    `TARGET             : ${p.target ?? '(none — dry-run)'}`,
    p.errors.length
      ? `REFUSED            :\n${p.errors.map((e) => `  - ${e}`).join('\n')}`
      : '─────────────────────────────────────────────────────',
  ].join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const p = buildPlan(argv);
  process.stdout.write(`${renderConfirmation(p)}\n`);
  if (p.errors.length > 0 || !p.scenario) return 2;
  if (!p.allowLoad || !p.target) {
    process.stdout.write(
      '\nDry-run only — no load generated. Add --allow-load and --target to run.\n',
    );
    return 0;
  }
  const { loadLivekitEnv } = await import('../livekit/tokens');
  const env = loadLivekitEnv();
  if (!env) {
    process.stderr.write('LOADTEST_LIVEKIT_* env not set — refusing MP run.\n');
    return 4;
  }
  const { runSupervisor } = await import('../mp/supervisor');
  const result = await runSupervisor({
    scenario: p.scenario,
    env,
    workers: p.workers,
    mediaPath: p.mediaPath,
    holdSeconds: p.scenario.holdSeconds,
    eventCsvPath: p.eventOut,
  });
  process.stdout.write(`\nMP RESULT: ${JSON.stringify(result)}\n`);
  if (result.aborted || !result.gateMet) {
    process.stderr.write(`RUN ABORTED: ${result.abortReason ?? 'gate not met'}\n`);
    return 5;
  }
  return 0;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
