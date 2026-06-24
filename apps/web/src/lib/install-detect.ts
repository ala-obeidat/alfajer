// Pure PWA-install detection helpers. Kept in a plain .ts module (no Svelte
// runes) so they can be unit-tested directly — install.svelte.ts holds only
// the reactive state and imports from here.

/** Platform signals we need to decide whether to show manual-install help. */
export interface AppleInstallEnv {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
}

/**
 * True when the browser CAN install this PWA but will never fire
 * `beforeinstallprompt`, so we must show manual "Add to Home Screen"
 * instructions. Covers iOS Safari (and any iOS WebView, which all use
 * WebKit) plus desktop Safari on macOS. Returns false when already running
 * as an installed standalone app, or on Chromium/Firefox where the native
 * prompt path handles it.
 */
export function appleManualInstallEligible(env: AppleInstallEnv): boolean {
  if (env.standalone) return false;
  const ua = env.userAgent || '';

  // iPadOS 13+ reports a desktop Mac UA; the touch-point count is what
  // distinguishes an iPad from a real trackpad Mac.
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (env.platform === 'MacIntel' && env.maxTouchPoints > 1);

  // Desktop Safari: WebKit on macOS that isn't one of the Chromium/Gecko
  // engines (which bring their own crios/fxios/edg tokens).
  const isMacSafari = /Macintosh/.test(ua)
    && /Safari/.test(ua)
    && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\//.test(ua);

  return isIOS || isMacSafari;
}

/** Reads the live browser environment for appleManualInstallEligible(). */
export function readAppleInstallEnv(): AppleInstallEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent || '',
    platform: nav.platform || '',
    maxTouchPoints: nav.maxTouchPoints || 0,
    standalone: window.matchMedia('(display-mode: standalone)').matches
      || nav.standalone === true
  };
}
