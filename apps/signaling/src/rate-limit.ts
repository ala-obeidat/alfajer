// Simple in-memory rolling-window rate limiter keyed by client IP.
// Designed for single-instance deployments — there's no shared state.
//
// Each instance enforces N requests per WINDOW_MS per key. Expired buckets
// are evicted lazily on access, plus a 60-second sweep to keep the map
// from growing unbounded when a flood of unique IPs hits us.

const WINDOW_MS = 60_000;

interface Bucket { count: number; resetAt: number; }

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private maxPerMinute: number, private name: string = 'rl') {
    this.gcTimer = setInterval(() => this.gc(), WINDOW_MS);
    // Don't keep the event loop alive just for GC.
    if (typeof (this.gcTimer as any).unref === 'function') (this.gcTimer as any).unref();
  }

  /** Returns true if the request is allowed (and increments the counter). */
  hit(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    if (b.count >= this.maxPerMinute) return false;
    b.count++;
    return true;
  }

  private gc() {
    const now = Date.now();
    for (const [k, v] of this.buckets) {
      if (v.resetAt <= now) this.buckets.delete(k);
    }
  }
}

/**
 * Pulls a stable client IP out of the incoming request headers. Caddy puts
 * the upstream client in both X-Real-IP and X-Forwarded-For. Falls back to
 * "unknown" so all unkeyed traffic shares one bucket (still rate-limited).
 */
export function clientIp(headers: Headers | Record<string, string | undefined>): string {
  const get = (k: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(k) ?? undefined;
    return headers[k];
  };
  const real = get('x-real-ip') || get('X-Real-IP');
  if (real) return real.trim();
  const fwd = get('x-forwarded-for') || get('X-Forwarded-For');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}
