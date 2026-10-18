export type BackoffPolicy = {
  /** Total tries including the first one. */
  maxAttempts: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
};

export const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return value;
}

function decimal(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(name + ' must be a number between ' + min + ' and ' + max);
  }
  return value;
}

/** Short in-request retries of individual HubSpot HTTP calls. */
export function httpRetryPolicy(): BackoffPolicy {
  const policy = {
    maxAttempts: integer('HUBSPOT_RETRY_MAX_ATTEMPTS', 5, 1, 10),
    initialDelayMs: integer('HUBSPOT_RETRY_INITIAL_DELAY_MS', 1000, 0, 60000),
    multiplier: decimal('HUBSPOT_RETRY_MULTIPLIER', 2, 1, 10),
    maxDelayMs: integer('HUBSPOT_RETRY_MAX_DELAY_MS', 30000, 0, 120000),
  };
  if (policy.maxDelayMs < policy.initialDelayMs) throw new Error('HUBSPOT_RETRY_MAX_DELAY_MS must be >= HUBSPOT_RETRY_INITIAL_DELAY_MS');
  return policy;
}

/** Durable order-level retries scheduled in PostgreSQL. maxAttempts counts automatic attempts only. */
export function orderRetryPolicy(): BackoffPolicy & { enabled: boolean; pollIntervalMs: number; staleAfterMs: number } {
  const enabled = (process.env.SYNC_AUTO_RETRY_ENABLED ?? 'true').trim().toLowerCase();
  if (!['true', 'false'].includes(enabled)) throw new Error('SYNC_AUTO_RETRY_ENABLED must be true or false');
  const policy = {
    enabled: enabled === 'true',
    maxAttempts: integer('SYNC_AUTO_RETRY_MAX_ATTEMPTS', 5, 0, 50),
    initialDelayMs: integer('SYNC_AUTO_RETRY_INITIAL_DELAY_MS', 60000, 1000, 86400000),
    multiplier: decimal('SYNC_AUTO_RETRY_MULTIPLIER', 2, 1, 10),
    maxDelayMs: integer('SYNC_AUTO_RETRY_MAX_DELAY_MS', 3600000, 1000, 604800000),
    pollIntervalMs: integer('SYNC_AUTO_RETRY_POLL_INTERVAL_MS', 15000, 1000, 3600000),
    staleAfterMs: integer('SYNC_AUTO_RETRY_STALE_AFTER_MS', 300000, 60000, 86400000),
  };
  if (policy.maxDelayMs < policy.initialDelayMs) throw new Error('SYNC_AUTO_RETRY_MAX_DELAY_MS must be >= SYNC_AUTO_RETRY_INITIAL_DELAY_MS');
  return policy;
}

/**
 * Delay before retry number `retry` (1 = first retry), using "equal jitter":
 * cap = min(maxDelay, initial * multiplier^(retry-1)); delay is uniform in [cap/2, cap].
 * The lower bound guarantees real spacing; the random half spreads synchronized clients.
 */
export function backoffDelay(retry: number, policy: Pick<BackoffPolicy, 'initialDelayMs' | 'multiplier' | 'maxDelayMs'>,
  random: () => number = Math.random): number {
  const cap = Math.min(policy.maxDelayMs, policy.initialDelayMs * Math.pow(policy.multiplier, Math.max(0, retry - 1)));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(cap / 2 + r * (cap / 2));
}

/** Retry-After as delta-seconds or an HTTP-date; returns milliseconds from `now`, or null if absent/invalid. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}
