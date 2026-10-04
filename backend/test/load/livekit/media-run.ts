/**
 * P8 load harness — media scenario orchestration (SFU-direct). Real runs only:
 * the CLI calls this solely after the safety gate decides `real-load`. It reaches
 * the WebRTC client through a DYNAMIC import of the media driver under
 * test/livekit/, so no file under test/load/ names `@livekit/rtc-node` and the
 * architecture test stays green.
 *
 * Flow: ensure rooms (loadtest- prefix) → ramp participants (publishers first)
 * → hold → optional churn → disconnect all → delete rooms → dispose the native
 * runtime. Tokens carry roomCreate so the first joiner creates the room off-box
 * without the LiveKit control API. Updates optional generator counters.
 */
import { type Scenario } from '../core/config';
import {
  type ParticipantPlan,
  connectOptionsFor,
  expandParticipants,
  roomName,
} from '../core/identity';
import { getScreenProfile } from '../core/screen-profiles';
import { StunResponder } from '../fleet/stun';
import { type GeneratorCounters } from '../metrics/generator';
import { type Driver, type LoadParticipantLike, type ScreenSpec } from '../mp/driver';
import { type IceConfig } from '../mp/types';
import { type LivekitEnv, deleteRooms, ensureRooms, mintTicket } from './tokens';

type Participant = LoadParticipantLike;

interface Tally {
  connected: number;
  failed: number;
  published: number;
  publishFailed: number;
}

interface RunCtx {
  readonly driver: Driver;
  readonly env: LivekitEnv;
  readonly ice: IceConfig;
  readonly relay: boolean;
  readonly screen: ScreenSpec | null;
  readonly live: Map<string, Participant>;
  readonly tally: Tally;
  readonly counters?: GeneratorCounters;
}

export interface MediaRunResult {
  readonly attempted: number;
  readonly connected: number;
  readonly failed: number;
  readonly published: number;
  readonly publishFailed: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function loadDriver(): Promise<Driver> {
  return import('../../livekit/load/media-driver');
}

async function admit(ctx: RunCtx, plan: ParticipantPlan): Promise<void> {
  const { counters } = ctx;
  try {
    const ticket = await mintTicket(ctx.env, {
      identity: plan.identity,
      room: plan.room,
      role: plan.role,
      roomCreate: true,
    });
    const participant = await ctx.driver.LoadParticipant.connect(
      ticket,
      connectOptionsFor(plan.role, ctx.ice),
    );
    ctx.live.set(plan.identity, participant);
    ctx.tally.connected += 1;
    if (counters) {
      counters.connectOk += 1;
      if (ctx.relay) counters.relayOk += 1;
      if (plan.role === 'listener') counters.subscribeOk += 1;
    }
    try {
      if (plan.role === 'speaker') await participant.publishMicrophone();
      else if (plan.role === 'screen')
        await participant.publishScreenShare(ctx.screen ?? defaultScreen());
      if (plan.role !== 'listener') {
        ctx.tally.published += 1;
        if (counters) counters.publishOk += 1;
      }
    } catch {
      ctx.tally.publishFailed += 1;
      if (counters) counters.publishFail += 1;
    }
  } catch {
    ctx.tally.failed += 1;
    if (counters) {
      counters.connectFail += 1;
      if (ctx.relay) counters.relayFail += 1;
      if (plan.role === 'listener') counters.subscribeFail += 1;
    }
  }
}

function defaultScreen(): ScreenSpec {
  return { width: 640, height: 360, fps: 15, maxBitrateKbps: 600 };
}

function resolveScreen(scenario: Scenario): ScreenSpec | null {
  if (!scenario.screenProfile) return null;
  const p = getScreenProfile(scenario.screenProfile);
  return p
    ? { width: p.width, height: p.height, fps: p.fps, maxBitrateKbps: p.maxBitrateKbps }
    : null;
}

export async function runMediaScenario(
  scenario: Scenario,
  env: LivekitEnv,
  counters?: GeneratorCounters,
): Promise<MediaRunResult> {
  const driver = await loadDriver();
  const plan = expandParticipants(scenario);
  const rooms = Array.from({ length: scenario.rooms }, (_, i) => roomName(scenario, i));
  // P8.4 errata E2: never the SDK-default ICE list (it pulls in the server's TURN).
  // Non-relay runs get an explicit TURN-free list served by an in-process STUN responder.
  const stun = scenario.relay ? null : new StunResponder({ port: 0, host: '127.0.0.1' });
  const ice: IceConfig = stun
    ? { mode: 'turn-free', stunUrls: [`stun:127.0.0.1:${(await stun.start()).port}`] }
    : { mode: 'relay' };
  const ctx: RunCtx = {
    driver,
    env,
    ice,
    relay: scenario.relay,
    screen: resolveScreen(scenario),
    live: new Map<string, Participant>(),
    tally: { connected: 0, failed: 0, published: 0, publishFailed: 0 },
    counters,
  };

  await ensureRooms(env, rooms);
  try {
    for (let i = 0; i < plan.length; i += scenario.rampPerSecond) {
      const batch = plan.slice(i, i + scenario.rampPerSecond);
      await Promise.all(batch.map((p) => admit(ctx, p)));
      if (i + scenario.rampPerSecond < plan.length) await sleep(1000);
    }
    if (scenario.churn) await runChurn(ctx, scenario, plan);
    else await sleep(scenario.holdSeconds * 1000);
  } finally {
    for (const participant of ctx.live.values())
      await participant.disconnect().catch(() => undefined);
    await deleteRooms(env, rooms);
    await driver.disposeMedia().catch(() => undefined);
    await stun?.close();
  }

  return {
    attempted: plan.length,
    connected: ctx.tally.connected,
    failed: ctx.tally.failed,
    published: ctx.tally.published,
    publishFailed: ctx.tally.publishFailed,
  };
}

async function runChurn(
  ctx: RunCtx,
  scenario: Scenario,
  plan: readonly ParticipantPlan[],
): Promise<void> {
  const churn = scenario.churn;
  if (!churn) return;
  const listeners = plan.filter((p) => p.role === 'listener');
  const dropCount = Math.floor(listeners.length * churn.dropFraction);
  for (let cycle = 0; cycle < churn.cycles; cycle += 1) {
    const victims = listeners.slice(0, dropCount);
    for (const v of victims) {
      await ctx.live
        .get(v.identity)
        ?.disconnect()
        .catch(() => undefined);
      ctx.live.delete(v.identity);
    }
    if (ctx.counters) ctx.counters.reconnects += victims.length;
    await sleep(Math.round((churn.cycleSeconds * 1000) / 2));
    for (const v of victims) await admit(ctx, v);
    await sleep(Math.round((churn.cycleSeconds * 1000) / 2));
  }
}
