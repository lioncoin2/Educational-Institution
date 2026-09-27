/**
 * The shape of every id Live issues or is given — a session's and a speaker
 * request's are uuids, and so is every account id identity issues; this
 * leaves room. One definition, for two rules:
 *
 *   isLiveId                      whether a path or a cursor names an id
 *                                 this API could have issued (the use
 *                                 cases' first check, live-settings.ts)
 *   isIssuedParticipantIdentity   whether a media identity is one this
 *                                 application issued
 *
 * `#` is never part of it.
 */
const LIVE_ID_SHAPE = /^[A-Za-z0-9:_-]{1,128}$/;

/** Whether `raw` could be an id this API issued (`LIVE_ID_SHAPE`). */
export function isLiveId(raw: string): boolean {
  return LIVE_ID_SHAPE.test(raw);
}

/**
 * The identity contract (P7.1; audit S2): the application issues exactly one
 * media identity per account — the account id, in every join token — so
 * every identity it issued has the id shape.
 *
 * Anything else in a room was chosen by a client. LiveKit v1.13.7 appends
 * `#<publish>` to a publishing token's identity when the client adds a
 * `publish` connect parameter (SRV `pkg/service/utils.go:378-387`), and no
 * server option turns that off: such a participant is a second, standard
 * participant whose name the client picked. It is nobody's: the reconciler
 * removes every standard participant this rule refuses — never asking
 * Communities or identity about it — and never counts it as a person.
 */
export function isIssuedParticipantIdentity(identity: string): boolean {
  return isLiveId(identity);
}

/**
 * The account whose token a refused identity was made from: the part before
 * the first `#` — the token's own identity, as LiveKit builds
 * `<identity>#<publish>` — when that part is an id; null otherwise. For
 * logs only, so that nothing a client chose is ever written: the suffix, or
 * a whole identity that is no id, never leaves this function.
 */
export function baseAccountOf(identity: string): string | null {
  const [base = ''] = identity.split('#', 1);
  return isLiveId(base) ? base : null;
}
