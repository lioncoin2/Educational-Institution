/**
 * P8 load harness — media scenario orchestration (SFU-direct). Real runs only:
 * the CLI calls this solely after the safety gate decides `real-load`. It reaches
 * the WebRTC client through a DYNAMIC import of the media driver under
 * test/livekit/, so no file under test/load/ names `@livekit/rtc-node` and the
 * architecture test stays green.
 *
 * Flow: ensure rooms (loadtest- prefix) → ramp participants (publishers first)
 * → hold → optional churn → disconnect all → delete rooms → dispose the native
 * runtime. Counts successes and failures; collects nothing itself (the collector
 * runs in parallel).
 */
import { type Scenario } from '../core/config';
import { type ParticipantPlan, expandParticipants, roomName } from '../core/identity';
import { type LivekitEnv, type MediaTicket, deleteRooms, ensureRooms, mintTicket } from './tokens';

/**
 * The driver's public surface, described structurally so this file has NO static
 * import of (and no type edge to) the WebRTC client. The real implementation is
 * test/livekit/load/media-driver.ts, loaded by dynamic import at run time.
 */
interface LoadParticipantLike {
  readonly identity: string;
  publishMicrophone(): Promise<void>;
  publishScreenShare(): Promise<void>;
  disconnect(): Promise<void>;
}
interface Driver {
  readonly LoadParticipant: {
    connect(
      ticket: MediaTicket,
      opts: { subscribe: boolean; relay: boolean },
    ): Promise<LoadParticipantLike>;
  };
  disposeMedia(): Promise<void>;
}
type Participant = LoadParticipantLike;

export interface MediaRunResult {
  readonly attempted: number;
  readonly connected: number;
  readonly failed: number;
  readonly published: number;
  readonly publishFailed: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Dynamically loads the media driver. Isolated so static analysis sees no rtc-node here. */
async function loadDriver(): Promise<Driver> {
  return import('../../livekit/load/media-driver');
}

async function admit(
  driver: Driver,
  env: LivekitEnv,
  plan: ParticipantPlan,
  relay: boolean,
  live: Map<string, Participant>,
  tally: { connected: number; failed: number; published: number; publishFailed: number },
): Promise<void> {
  try {
    const ticket = await mintTicket(env, {
      identity: plan.identity,
      room: plan.room,
      role: plan.role,
    });
    const participant = await driver.LoadParticipant.connect(ticket, {
      subscribe: plan.role === 'listener',
      relay,
    });
    live.set(plan.identity, participant);
    tally.connected += 1;
    try {
      if (plan.role === 'speaker') await participant.publishMicrophone();
      else if (plan.role === 'screen') await participant.publishScreenShare();
      if (plan.role !== 'listener') tally.published += 1;
    } catch {
      tally.publishFailed += 1;
    }
  } catch {
    tally.failed += 1;
  }
}

export async function runMediaScenario(
  scenario: Scenario,
  env: LivekitEnv,
): Promise<MediaRunResult> {
  const driver = await loadDriver();
  const plan = expandParticipants(scenario);
  const rooms = Array.from({ length: scenario.rooms }, (_, i) => roomName(scenario, i));
  const live = new Map<string, Participant>();
  const tally = { connected: 0, failed: 0, published: 0, publishFailed: 0 };

  await ensureRooms(env, rooms);

  try {
    // Ramp-up: admit rampPerSecond participants each second, in plan order.
    for (let i = 0; i < plan.length; i += scenario.rampPerSecond) {
      const batch = plan.slice(i, i + scenario.rampPerSecond);
      await Promise.all(batch.map((p) => admit(driver, env, p, scenario.relay, live, tally)));
      if (i + scenario.rampPerSecond < plan.length) await sleep(1000);
    }

    // Hold, then optional reconnect/churn cycles.
    if (scenario.churn) {
      await runChurn(driver, env, scenario, plan, live, tally);
    } else {
      await sleep(scenario.holdSeconds * 1000);
    }
  } finally {
    for (const participant of live.values()) await participant.disconnect().catch(() => undefined);
    await deleteRooms(env, rooms);
    await driver.disposeMedia().catch(() => undefined);
  }

  return {
    attempted: plan.length,
    connected: tally.connected,
    failed: tally.failed,
    published: tally.published,
    publishFailed: tally.publishFailed,
  };
}

async function runChurn(
  driver: Driver,
  env: LivekitEnv,
  scenario: Scenario,
  plan: readonly ParticipantPlan[],
  live: Map<string, Participant>,
  tally: { connected: number; failed: number; published: number; publishFailed: number },
): Promise<void> {
  const churn = scenario.churn;
  if (!churn) return;
  const listeners = plan.filter((p) => p.role === 'listener');
  const dropCount = Math.floor(listeners.length * churn.dropFraction);
  for (let cycle = 0; cycle < churn.cycles; cycle += 1) {
    const victims = listeners.slice(0, dropCount);
    for (const v of victims) {
      await live
        .get(v.identity)
        ?.disconnect()
        .catch(() => undefined);
      live.delete(v.identity);
    }
    await sleep(Math.round((churn.cycleSeconds * 1000) / 2));
    for (const v of victims) await admit(driver, env, v, scenario.relay, live, tally);
    await sleep(Math.round((churn.cycleSeconds * 1000) / 2));
  }
}
