/**
 * Plain-words causes for image-pull failures. Docker reports a Hub rate limit
 * as `toomanyrequests` / 429, and swarmy's pull-through cache
 * (`swarmy-registry-cache`, `localhost:5001`) turns an upstream 429 into a bare
 * 500, so the deploy said "500" and nothing else. This prefixes the cause and
 * the fix to the message, keeping Docker's own text after it. PURE and
 * idempotent (an explained message is returned unchanged).
 */

export const HUB_RATE_LIMIT_CAUSE = 'Docker Hub rate limit';
export const CACHE_FAILURE_CAUSE = 'Docker Hub pull-through cache error';

const RATE_LIMIT = /toomanyrequests|too many requests|\b429\b|pull rate limit|rate limit(ed)? (reached|exceeded)/i;
/** A 5xx from the cache — mirror at :5001, or the cache service by name. */
const CACHE_5XX =
  /((localhost|127\.0\.0\.1):5001|swarmy-registry-cache)[\s\S]*(\b50[0-4]\b|internal server error|bad gateway|service unavailable)|(\b50[0-4]\b|internal server error)[\s\S]*((localhost|127\.0\.0\.1):5001|swarmy-registry-cache)/i;

/** A bare registry 5xx during a pull (dockerd hides which mirror answered). */
const PULL_5XX = /unexpected HTTP status:? 50[0-4]|error (pulling|from registry)[\s\S]*\b50[0-4]\b/i;

export function explainImagePullError(message: string): string {
  if (!message || message.startsWith(HUB_RATE_LIMIT_CAUSE) || message.startsWith(CACHE_FAILURE_CAUSE)) return message;
  if (RATE_LIMIT.test(message)) {
    return `${HUB_RATE_LIMIT_CAUSE}: Docker Hub refused the pull (anonymous pulls are capped per IP). Add a Docker Hub login to the pull-through cache (CI → Registry), or wait for the limit to reset. Docker said: ${message}`;
  }
  if (CACHE_5XX.test(message)) {
    return `${CACHE_FAILURE_CAUSE}: swarmy-registry-cache could not fetch the image from Docker Hub, usually because Hub is rate-limiting anonymous pulls. Add a Docker Hub login to the cache (CI → Registry). Docker said: ${message}`;
  }
  if (PULL_5XX.test(message)) {
    return `${CACHE_FAILURE_CAUSE}: a registry answered 5xx during the pull. For a Docker Hub image that is swarmy-registry-cache failing upstream, usually because Hub is rate-limiting anonymous pulls. Add a Docker Hub login to the cache (CI → Registry). Docker said: ${message}`;
  }
  return message;
}
