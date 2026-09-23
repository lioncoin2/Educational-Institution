/**
 * The read watermark after "I have read up to `requested`": it never moves
 * backwards (a stale device cannot un-read), and never past the last message
 * (a client cannot pre-read the future).
 */
export function advancedWatermark(
  current: number,
  requested: number,
  lastSequence: number,
): number {
  return Math.max(current, Math.min(requested, lastSequence));
}
