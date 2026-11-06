/**
 * One emoji's reactions on a message: how many members chose it, and whether
 * the viewer is one of them. Only emoji with at least one reaction appear.
 *
 * In its own file — with no dependency on Files or anything else — so the
 * messaging DOMAIN may name it (the repository port returns it) without the
 * domain reaching another module, which the messaging-boundaries test forbids.
 */
export interface MessageReactionView {
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}
