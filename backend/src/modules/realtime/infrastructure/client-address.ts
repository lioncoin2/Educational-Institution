/**
 * The client's address for a raw upgrade request, by the same rule Express
 * applies to HTTP requests with the configured `trust proxy` setting — an
 * upgrade never passes through Express, so the rule is restated here:
 *
 *   false     the socket's peer; X-Forwarded-For is ignored (anyone can send it)
 *   true      the left-most X-Forwarded-For entry — every proxy is trusted
 *   n hops    the address n hops from the socket, counting the proxies' own
 *             appended entries from the right
 *
 * Used for rate limiting only. It is never an identity.
 */
export function clientAddress(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy: boolean | number,
): string {
  const peer = remoteAddress ?? 'unknown';
  if (trustProxy === false || trustProxy === 0) return peer;

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const forwarded = header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // Nearest first: the socket's peer, then each proxy's entry from the right.
  const chain = [peer, ...forwarded.reverse()];
  const hops = trustProxy === true ? chain.length - 1 : Math.min(trustProxy, chain.length - 1);
  return chain[hops] ?? peer;
}
