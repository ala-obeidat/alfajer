// Captures the `beforeinstallprompt` event so we can offer a manual
// "Install Alfajer" trigger on the home page without browser nagging.
//
// Safari (iOS and macOS) never fires `beforeinstallprompt` — there is no
// programmatic install on WebKit at all. The only way to install is the user
// picking "Add to Home Screen" (iOS) / "Add to Dock" (macOS Safari 17+) from
// the Share menu. So for those browsers we detect eligibility ourselves and
// surface manual instructions instead of a one-tap button.

import { appleManualInstallEligible, readAppleInstallEnv } from './install-detect';

type BIPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const DISMISS_KEY = 'alfajer.installDismissedAt';
const DISMISS_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

class InstallState {
  prompt = $state<BIPromptEvent | null>(null);
  installed = $state(false);
  // True on Safari/iOS, where there is no programmatic install: the home
  // page shows manual "Add to Home Screen" guidance instead of a button.
  manualInstall = $state(false);

  init() {
    if (typeof window === 'undefined') return;
    // Already installed?
    if (window.matchMedia('(display-mode: standalone)').matches
      || (navigator as any).standalone === true) {
      this.installed = true;
      return;
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.prompt = e as BIPromptEvent;
      // A real native prompt is available — no need for manual instructions.
      this.manualInstall = false;
    });
    window.addEventListener('appinstalled', () => {
      this.installed = true;
      this.prompt = null;
      this.manualInstall = false;
    });
    // Safari/iOS path: decide up front, since beforeinstallprompt won't fire.
    this.manualInstall = appleManualInstallEligible(readAppleInstallEnv());
  }

  isDismissed(): boolean {
    try {
      const v = localStorage.getItem(DISMISS_KEY);
      if (!v) return false;
      const ts = parseInt(v, 10);
      return Number.isFinite(ts) && Date.now() - ts < DISMISS_TTL;
    } catch { return false; }
  }

  dismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
    this.prompt = null;
    this.manualInstall = false;
  }

  async show(): Promise<boolean> {
    if (!this.prompt) return false;
    const p = this.prompt;
    this.prompt = null;
    await p.prompt();
    const choice = await p.userChoice;
    return choice.outcome === 'accepted';
  }
}

export const install = new InstallState();
