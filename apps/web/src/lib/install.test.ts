import { describe, it, expect } from 'vitest';
import { appleManualInstallEligible, type AppleInstallEnv } from './install-detect';

const base: AppleInstallEnv = {
  userAgent: '',
  platform: '',
  maxTouchPoints: 0,
  standalone: false
};

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const IPADOS_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

describe('appleManualInstallEligible', () => {
  it('is true for iPhone Safari', () => {
    expect(appleManualInstallEligible({ ...base, userAgent: IPHONE_SAFARI })).toBe(true);
  });

  it('is true for an in-app iOS browser (still WebKit / Add to Home Screen)', () => {
    expect(appleManualInstallEligible({ ...base, userAgent: IPHONE_CHROME })).toBe(true);
  });

  it('is true for desktop macOS Safari', () => {
    expect(appleManualInstallEligible({ ...base, userAgent: MAC_SAFARI })).toBe(true);
  });

  it('is true for iPadOS (desktop UA + touch points)', () => {
    expect(appleManualInstallEligible({
      ...base, userAgent: IPADOS_SAFARI, platform: 'MacIntel', maxTouchPoints: 5
    })).toBe(true);
  });

  it('is false for macOS Chrome (native prompt path handles it)', () => {
    expect(appleManualInstallEligible({ ...base, userAgent: MAC_CHROME })).toBe(false);
  });

  it('is false for Android Chrome', () => {
    expect(appleManualInstallEligible({ ...base, userAgent: ANDROID_CHROME })).toBe(false);
  });

  it('is false for a real Mac (no touch points, Chrome)', () => {
    expect(appleManualInstallEligible({
      ...base, userAgent: MAC_CHROME, platform: 'MacIntel', maxTouchPoints: 0
    })).toBe(false);
  });

  it('is false when already running standalone, even on iPhone', () => {
    expect(appleManualInstallEligible({
      ...base, userAgent: IPHONE_SAFARI, standalone: true
    })).toBe(false);
  });
});
