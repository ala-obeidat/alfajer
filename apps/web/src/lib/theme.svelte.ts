// Light / dark / auto theme. Applies a `data-theme` attribute on <html>.
// CSS palettes for both themes live in app.css.

import { prefs } from './prefs';

type Mode = 'auto' | 'dark' | 'light';

class ThemeState {
  mode = $state<Mode>('auto');
  resolved = $state<'dark' | 'light'>('dark');
  private media: MediaQueryList | null = null;

  init() {
    if (typeof window === 'undefined') return;
    this.mode = prefs.getTheme();
    this.media = window.matchMedia('(prefers-color-scheme: light)');
    this.media.addEventListener('change', () => this.recompute());
    this.recompute();
  }

  setMode(m: Mode) {
    this.mode = m;
    prefs.setTheme(m);
    this.recompute();
  }

  cycle() {
    // dark → light → auto → dark …
    const next: Mode = this.mode === 'dark' ? 'light' : this.mode === 'light' ? 'auto' : 'dark';
    this.setMode(next);
  }

  private recompute() {
    let r: 'dark' | 'light';
    if (this.mode === 'auto') {
      r = this.media?.matches ? 'light' : 'dark';
    } else {
      r = this.mode;
    }
    this.resolved = r;
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', r);
    }
  }
}

export const theme = new ThemeState();
