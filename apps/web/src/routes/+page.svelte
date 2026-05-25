<script lang="ts">
  import { onMount } from 'svelte';
  import { getOrGenerateIdentity, clearIdentity } from '../lib/identity';

  let nickname = $state('');
  let mode = $state<'choose' | 'join'>('choose');
  let roomCode = $state('');
  let error = $state('');

  onMount(() => {
    // If a nickname is already remembered for this tab, pre-fill but allow change
    const existing = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem('alfajer_identity')
      : null;
    if (existing) {
      // identity is "@<nickname>-<hex>", show just the nickname portion
      const m = existing.match(/^@([^-]+)-/);
      if (m) nickname = m[1];
    }
  });

  function generateRoomId(): string {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return String(100000 + (buf[0] % 900000));
  }

  function persistNickname(): boolean {
    const trimmed = nickname.trim();
    if (!trimmed) {
      error = 'Please enter a nickname';
      return false;
    }
    // Reset stored identity so getOrGenerateIdentity picks up the new nickname
    clearIdentity();
    getOrGenerateIdentity(trimmed);
    error = '';
    return true;
  }

  function startNewCall() {
    if (!persistNickname()) return;
    const id = generateRoomId();
    window.location.href = `/call/${id}?init=true`;
  }

  function showJoinForm() {
    if (!persistNickname()) return;
    mode = 'join';
  }

  function joinCall() {
    if (!persistNickname()) return;
    const code = roomCode.trim();
    if (!/^\d{6}$/.test(code)) {
      error = 'Enter a 6-digit room code';
      return;
    }
    window.location.href = `/call/${code}`;
  }

  function backToChoose() {
    mode = 'choose';
    roomCode = '';
    error = '';
  }

  function onRoomCodeInput(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    // Strip anything non-numeric so paste/IME doesn't break the pattern
    roomCode = v.replace(/\D/g, '').slice(0, 6);
  }
</script>

<div class="landing">
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
      <path
        d="M32 4 L56 14 V32 C56 46 45 56 32 60 C19 56 8 46 8 32 V14 Z"
        fill="url(#shieldGrad)"
        opacity="0.95"
      />
      <path
        d="M22 32 L29 39 L42 26"
        stroke="white"
        stroke-width="4"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
      <circle cx="32" cy="50" r="2.2" fill="white" opacity="0.85" />
    </svg>

    <h1>Alfajer</h1>
    <p class="tagline">
      Fully anonymous, private, secret <strong>1-to-1</strong> calls.<br />
      <span class="muted">No accounts. No logs. End-to-end via WebRTC.</span>
    </p>
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
      <div class="actions stacked">
        <button class="primary" onclick={startNewCall}>Start new call</button>
        <button class="ghost" onclick={showJoinForm}>Join existing call</button>
      </div>
    {:else}
      <label class="field">
        <span>6-digit room code</span>
        <input
          type="text"
          value={roomCode}
          oninput={onRoomCodeInput}
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="6"
          placeholder="123456"
          autocomplete="off"
          class="code"
        />
      </label>
      <div class="actions stacked">
        <button class="primary" onclick={joinCall}>Join call</button>
        <button class="ghost" onclick={backToChoose}>Back</button>
      </div>
    {/if}

    {#if error}
      <div class="err" role="alert">{error}</div>
    {/if}
  </div>

  <footer class="foot">
    <span class="muted">Room state lives only in memory. When everyone leaves, it's gone.</span>
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
    color: var(--text-primary);
  }

  .muted {
    color: var(--text-secondary);
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

  .actions {
    display: flex;
    gap: 0.75rem;
  }

  .actions.stacked {
    flex-direction: column;
  }

  .actions button {
    inline-size: 100%;
    min-block-size: 48px;
    font-size: 1rem;
    border-radius: 10px;
  }

  .primary {
    background: var(--accent);
  }

  .ghost {
    background: transparent;
    color: var(--text-primary);
    border: 1px solid var(--text-secondary);
  }

  .ghost:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .err {
    color: #fca5a5;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.35);
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    font-size: 0.9rem;
    text-align: center;
  }

  .foot {
    text-align: center;
    font-size: 0.85rem;
    max-inline-size: 32rem;
  }

  @media (max-width: 480px) {
    .landing {
      gap: 1.25rem;
      padding-block: 1rem;
    }
    .card {
      padding: 1.25rem;
    }
  }
</style>
