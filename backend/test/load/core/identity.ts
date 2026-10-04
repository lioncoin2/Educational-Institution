/**
 * P8 load harness — deterministic identities and room names. Everything the
 * harness creates is reproducible from the scenario id and an index, and every
 * SFU-direct room carries a NON-application prefix so the live reconciler's
 * prefix-scoped sweep never deletes it and its foreign-identity enforcement
 * never runs on it (P8 plan F7). Pure.
 */
import { type Scenario, participantsPerRoom } from './config';

/**
 * The room-name prefix for SFU-direct load rooms. It must NOT match the
 * application's `LIVE_ROOM_NAME_PREFIX` (`live-staging-`), or the reconciler
 * would treat these as orphaned deployment rooms and delete them.
 */
export const LOAD_ROOM_PREFIX = 'loadtest-';

export type Role = 'listener' | 'speaker' | 'screen';

export interface ParticipantPlan {
  readonly room: string;
  readonly roomIndex: number;
  readonly identity: string;
  readonly role: Role;
}

/** The room name for room `index` of a scenario. Deterministic. */
export function roomName(scenario: Scenario, index: number): string {
  return `${LOAD_ROOM_PREFIX}${scenario.id}-r${index}`;
}

/** The identity for one participant. Deterministic and self-describing. */
export function identity(scenario: Scenario, roomIndex: number, role: Role, seat: number): string {
  return `${scenario.id}-r${roomIndex}-${role}-${seat}`;
}

/**
 * Expands a scenario into its full participant plan, room by room. Speakers come
 * first (seat 0 is the "teacher"), then screen-share publishers, then listeners,
 * so ramp-up admits the publisher(s) before the audience. Deterministic order.
 */
export function expandParticipants(scenario: Scenario): ParticipantPlan[] {
  const plan: ParticipantPlan[] = [];
  for (let r = 0; r < scenario.rooms; r += 1) {
    const room = roomName(scenario, r);
    let seat = 0;
    for (let i = 0; i < scenario.speakersPerRoom; i += 1, seat += 1)
      plan.push({
        room,
        roomIndex: r,
        identity: identity(scenario, r, 'speaker', i),
        role: 'speaker',
      });
    for (let i = 0; i < scenario.screenSharesPerRoom; i += 1, seat += 1)
      plan.push({
        room,
        roomIndex: r,
        identity: identity(scenario, r, 'screen', i),
        role: 'screen',
      });
    for (let i = 0; i < scenario.listenersPerRoom; i += 1, seat += 1)
      plan.push({
        room,
        roomIndex: r,
        identity: identity(scenario, r, 'listener', i),
        role: 'listener',
      });
  }
  return plan;
}

/** A sanity cross-check used by tests: the plan length equals the derived total. */
export function expectedPlanSize(scenario: Scenario): number {
  return participantsPerRoom(scenario) * scenario.rooms;
}

/**
 * The connect options for a role: listeners subscribe; publishers do not
 * auto-subscribe (they only send). The ICE mode (TURN-free or forced relay,
 * P8.4 §17) is the run's, the same for every role. Pure.
 */
export function connectOptionsFor<Ice>(
  role: Role,
  ice: Ice,
): { readonly subscribe: boolean; readonly ice: Ice } {
  return { subscribe: role === 'listener', ice };
}
