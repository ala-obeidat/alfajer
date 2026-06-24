<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { getOrGenerateIdentity, clearIdentity } from '../lib/identity';
  import { prefs } from '$lib/prefs';
  import { install } from '$lib/install.svelte';
  import { theme } from '$lib/theme.svelte';
  import { toast } from '$lib/toast.svelte';
  import Icon from '$lib/Icon.svelte';

  let nickname = $state('');
  let mode = $state<'choose' | 'join'>('choose');
  let roomCode = $state('');
  let error = $state('');
  let audioOnly = $state(false);

  onMount(() => {
    // Prefer the existing session identity (so refresh doesn't lose it),
    // then fall back to the last-used nickname from localStorage.
    const existing = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem('alfajer_identity')
      : null;
    if (existing) {
      const m = existing.match(/^@([^-]+)-/);
      if (m) nickname = m[1];
    } else {
      nickname = prefs.getNickname();
    }
    audioOnly = prefs.getAudioOnly();
  });

  function generateRoomId(): string {
    // 9 digits = 1 billion possible codes. With our 30-WS-conn/min/IP rate
    // limit a single attacker covers ~43k codes/day → exhausting the space
    // would take ~63 years. A 1k-IP botnet still needs ~3 weeks. Combined
    // with the room-seal + knock acceptance, brute-force hijack is
    // economically infeasible.
    const buf = new Uint32Array(2);
    window.crypto.getRandomValues(buf);
    // Concat two random 32-bit values to get a number in [1e8, 1e9-1].
    const big = (BigInt(buf[0]) << 32n) | BigInt(buf[1]);
    const r = Number(big % 900_000_000n);
    return String(100_000_000 + r);
  }

  function persistNickname(): boolean {
    const trimmed = nickname.trim();
    if (!trimmed) {
      error = 'Please enter a nickname';
      return false;
    }
    clearIdentity();
    getOrGenerateIdentity(trimmed);
    prefs.setNickname(trimmed);
    prefs.setAudioOnly(audioOnly);
    error = '';
    return true;
  }

  function startNewCall() {
    if (!persistNickname()) return;
    const id = generateRoomId();
    const params = audioOnly ? '?init=true&audio=1' : '?init=true';
    window.location.href = `/call/${id}${params}`;
  }

  function showJoinForm() {
    if (!persistNickname()) return;
    mode = 'join';
  }

  function joinCall() {
    if (!persistNickname()) return;
    const code = roomCode.trim();
    // Accept the new 9-digit format. Legacy 6-digit codes still work
    // server-side; only the joiner-side input validation is tightened.
    if (!/^\d{6,9}$/.test(code)) {
      error = 'Enter the room code';
      return;
    }
    const params = audioOnly ? '?audio=1' : '';
    window.location.href = `/call/${code}${params}`;
  }

  function backToChoose() {
    mode = 'choose';
    roomCode = '';
    error = '';
  }

  function onRoomCodeInput(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    roomCode = v.replace(/\D/g, '').slice(0, 9);
  }

  function onCodeFocus(e: FocusEvent) {
    // Mobile keyboard covers about half the screen; scroll the input into
    // the visible region so it stays above the keyboard.
    const el = e.currentTarget as HTMLInputElement;
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
  }

  async function installApp() {
    const ok = await install.show();
    if (ok) toast.success('Alfajer installed. Find it on your home screen.');
  }
</script>

<div class="landing">
  <button class="theme-toggle" onclick={() => theme.cycle()} aria-label="Switch theme">
    {#key theme.resolved}
      <span in:fade={{ duration: 150 }}>
        <Icon name={theme.resolved === 'light' ? 'moon' : 'sun'} size={18} />
      </span>
    {/key}
  </button>

  <div class="hero">
    <svg
      class="shield"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="shieldGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#60a5fa" />
          <stop offset="1" stop-color="#2563eb" />
        </linearGradient>
      </defs>
      <path d="M32 4 L56 14 V32 C56 46 45 56 32 60 C19 56 8 46 8 32 V14 Z" fill="url(#shieldGrad)" opacity="0.95" />
      <path d="M22 32 L29 39 L42 26" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none" />
      <circle cx="32" cy="50" r="2.2" fill="white" opacity="0.85" />
    </svg>

    <h1>Alfajer</h1>
    <p class="tagline">
      Fully anonymous, private, secret <strong>1-to-1</strong> calls.<br />
      <span class="muted">No accounts. No logs. End-to-end via WebRTC.</span>
    </p>

    <div class="badges">
      <span class="badge" title="AES-256-GCM with per-direction HKDF keys derived from ECDH P-256">🔒 End-to-end encrypted</span>
      <span class="badge" title="Rooms live only in memory. Last byte erased when the second peer leaves.">📭 Nothing stored</span>
      <span class="badge" title="Self-hosted signaling and TURN. No third-party trackers.">⚡ Self-hosted</span>
    </div>
  </div>

  <div class="card" role="form">
    <label class="field">
      <span>Your nickname</span>
      <input
        type="text"
        bind:value={nickname}
        placeholder="What should we call you?"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        inputmode="text"
        required
      />
    </label>

    {#if mode === 'choose'}
      <div class="actions stacked" in:fade={{ duration: 150 }}>
        <button class="primary" onclick={startNewCall}>Start new call</button>
        <button class="ghost" onclick={showJoinForm}>Join existing call</button>
      </div>
    {:else}
      <label class="field" in:fly={{ y: -8, duration: 200 }}>
        <span>Room code</span>
        <input
          type="text"
          value={roomCode}
          oninput={onRoomCodeInput}
          onfocus={onCodeFocus}
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="9"
          placeholder="123 456 789"
          autocomplete="off"
          class="code"
        />
      </label>
      <div class="actions stacked">
        <button class="primary" onclick={joinCall}>Join call</button>
        <button class="ghost" onclick={backToChoose}>Back</button>
      </div>
    {/if}

    <label class="checkbox">
      <input type="checkbox" bind:checked={audioOnly} />
      <span>Voice-only call (no video)</span>
    </label>

    {#if error}
      <div class="err" role="alert" in:fly={{ y: -8, duration: 150 }}>{error}</div>
    {/if}
  </div>

  {#if install.prompt && !install.installed && !install.isDismissed()}
    <div class="install-banner" in:fly={{ y: 20, duration: 200 }}>
      <span>📲 Install Alfajer for one-tap calls and full-screen</span>
      <div class="install-actions">
        <button class="primary" onclick={installApp}>Install</button>
        <button class="ghost" onclick={() => install.dismiss()} aria-label="Dismiss install prompt">Dismiss</button>
      </div>
    </div>
  {:else if install.manualInstall && !install.installed && !install.isDismissed()}
    <!-- Safari/iOS never fires beforeinstallprompt, so there's no one-tap
         button — guide the user through the Share-sheet flow instead. -->
    <div class="install-banner ios" in:fly={{ y: 20, duration: 200 }}>
      <span>
        📲 Install Alfajer: tap
        <Icon name="share" size={15} />
        <strong>Share</strong>, then <strong>“Add to Home Screen”</strong>.
      </span>
      <div class="install-actions">
        <button class="ghost" onclick={() => install.dismiss()} aria-label="Dismiss install instructions">Got it</button>
      </div>
    </div>
  {/if}

  <footer class="foot">
    <span class="muted">Room state lives only in memory. When everyone leaves, it's gone.</span>
    <br />
    <a href="/privacy" class="muted">Privacy &amp; security details</a>
  </footer>
</div>

<style>
  .landing {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 2rem;
    padding-block: 1.5rem;
    inline-size: 100%;
    position: relative;
  }

  .theme-toggle {
    position: fixed;
    inset-block-start: max(env(safe-area-inset-top, 0px), 0.75rem);
    inset-inline-end: max(env(safe-area-inset-right, 0px), 0.75rem);
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.5rem;
    inline-size: 38px;
    block-size: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    z-index: 5;
  }

  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    text-align: center;
    max-inline-size: 32rem;
  }

  .shield {
    inline-size: clamp(64px, 14vw, 96px);
    block-size: clamp(64px, 14vw, 96px);
    filter: drop-shadow(0 8px 20px rgb(37 99 235 / 30%));
  }

  .hero h1 {
    margin: 0.25rem 0 0;
    font-size: clamp(1.75rem, 4.5vw, 2.5rem);
    letter-spacing: -0.02em;
  }

  .tagline {
    margin: 0;
    font-size: clamp(0.95rem, 2.6vw, 1.05rem);
    line-height: 1.5;
  }

  .muted { color: var(--text-secondary); }

  .badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.4rem;
    margin-block-start: 0.75rem;
  }

  .badge {
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    background: var(--code-bg);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    cursor: help;
  }

  .card {
    background-color: var(--bg-secondary);
    padding: 1.5rem;
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    inline-size: 100%;
    max-inline-size: 28rem;
    box-shadow: 0 10px 25px -10px rgb(0 0 0 / 50%);
    border: 1px solid var(--border);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .field > span {
    font-size: 0.85rem;
    color: var(--text-secondary);
    letter-spacing: 0.01em;
  }

  .field input {
    inline-size: 100%;
    font-size: 1rem;
    min-block-size: 48px;
  }

  .field input.code {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.4em;
    font-size: 1.3rem;
    text-align: center;
    padding-inline: 0.75rem;
  }

  .actions { display: flex; gap: 0.75rem; }
  .actions.stacked { flex-direction: column; }
  .actions button { inline-size: 100%; min-block-size: 48px; font-size: 1rem; border-radius: 10px; }

  .primary { background: var(--accent); }
  .ghost {
    background: transparent;
    color: var(--text-primary);
    border: 1px solid var(--border-strong);
  }
  .ghost:hover { background: var(--code-bg); }

  .checkbox {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin-block-start: 0.25rem;
    cursor: pointer;
  }
  .checkbox input { inline-size: 18px; block-size: 18px; accent-color: var(--accent); }

  .err {
    color: #fca5a5;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.35);
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    font-size: 0.9rem;
    text-align: center;
  }

  .install-banner {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.85rem 1rem;
    border-radius: 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    box-shadow: 0 8px 20px -8px rgb(0 0 0 / 50%);
    max-inline-size: 28rem;
    inline-size: 100%;
    color: var(--text-primary);
    font-size: 0.95rem;
  }
  .install-banner span { flex: 1; }
  /* Keep the inline Share glyph baseline-aligned with the iOS hint text. */
  .install-banner.ios span { display: inline; line-height: 1.5; }
  .install-banner.ios :global(svg) { vertical-align: -2px; margin-inline: 0.1rem; }
  .install-actions { display: flex; gap: 0.5rem; }
  .install-actions button { padding: 0.5rem 0.9rem; min-block-size: 38px; font-size: 0.9rem; }

  .foot {
    text-align: center;
    font-size: 0.85rem;
    max-inline-size: 32rem;
  }
  .foot a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
  .foot a:hover { color: var(--text-primary); }

  @media (max-width: 480px) {
    .landing { gap: 1.25rem; padding-block: 1rem; }
    .card { padding: 1.25rem; }
    .install-banner { flex-direction: column; align-items: stretch; }
  }
</style>
