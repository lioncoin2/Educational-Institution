import type { RateLimitPolicy } from '../../../shared';

/** Long enough for a slow mobile upload of the largest allowed file; no longer. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** A download link is a bearer capability: short, so a leaked one dies quickly. */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** DEVELOPMENT-SAFE DEFAULT, not a production policy (see authentication.md §8). */
export const UPLOAD_REQUESTS_PER_USER: RateLimitPolicy = {
  name: 'files.upload.user',
  limit: 60,
  windowSeconds: 600,
};
