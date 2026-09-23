import type { ParticipantRole } from '../contracts/participant-role';

export type { ParticipantRole };

export interface LiveParticipant {
  readonly sessionId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: ParticipantRole;
  readonly joinedAt: Date;
}

export function isModerator(participant: LiveParticipant): boolean {
  return participant.role === 'host';
}
