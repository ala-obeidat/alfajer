import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter, clientIp } from './rate-limit';

describe('RateLimiter', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('allows requests under the per-minute cap', () => {
    const r = new RateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(r.hit('1.2.3.4')).toBe(true);
    }
  });

  it('rejects the (N+1)th request in the same window', () => {
    const r = new RateLimiter(3);
    expect(r.hit('1.2.3.4')).toBe(true);
    expect(r.hit('1.2.3.4')).toBe(true);
    expect(r.hit('1.2.3.4')).toBe(true);
    expect(r.hit('1.2.3.4')).toBe(false); // hard cap
    expect(r.hit('1.2.3.4')).toBe(false); // still rejected
  });

  it('isolates buckets per IP', () => {
    const r = new RateLimiter(2);
    expect(r.hit('1.1.1.1')).toBe(true);
    expect(r.hit('1.1.1.1')).toBe(true);
    expect(r.hit('1.1.1.1')).toBe(false); // first IP exhausted
    expect(r.hit('2.2.2.2')).toBe(true);  // second IP fresh
    expect(r.hit('2.2.2.2')).toBe(true);
    expect(r.hit('2.2.2.2')).toBe(false);
  });

  it('resets the counter after the 60-second window expires', () => {
    vi.useFakeTimers();
    const r = new RateLimiter(2);
    expect(r.hit('1.1.1.1')).toBe(true);
    expect(r.hit('1.1.1.1')).toBe(true);
    expect(r.hit('1.1.1.1')).toBe(false);

    // Advance just past 60s
    vi.advanceTimersByTime(60_001);
    expect(r.hit('1.1.1.1')).toBe(true);
    expect(r.hit('1.1.1.1')).toBe(true);
    expect(r.hit('1.1.1.1')).toBe(false);
  });

  it('treats "unknown" IP as a single bucket so it is still rate-limited', () => {
    const r = new RateLimiter(2);
    expect(r.hit('unknown')).toBe(true);
    expect(r.hit('unknown')).toBe(true);
    expect(r.hit('unknown')).toBe(false);
  });
});

describe('clientIp', () => {
  it('prefers X-Real-IP over X-Forwarded-For', () => {
    const headers = { 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '9.9.9.9' };
    expect(clientIp(headers)).toBe('5.5.5.5');
  });

  it('falls back to first X-Forwarded-For hop when X-Real-IP is missing', () => {
    const headers = { 'x-forwarded-for': '10.0.0.1, 198.51.100.1, 203.0.113.1' };
    expect(clientIp(headers)).toBe('10.0.0.1');
  });

  it('returns "unknown" when no IP-carrying header is present', () => {
    expect(clientIp({})).toBe('unknown');
  });

  it('handles a Headers object (for symmetry with the WS open handler)', () => {
    const h = new Headers();
    h.set('x-real-ip', '203.0.113.42');
    expect(clientIp(h)).toBe('203.0.113.42');
  });

  it('trims whitespace from both header types', () => {
    expect(clientIp({ 'x-real-ip': '  1.2.3.4  ' })).toBe('1.2.3.4');
    expect(clientIp({ 'x-forwarded-for': '  4.4.4.4 , 5.5.5.5  ' })).toBe('4.4.4.4');
  });
});
