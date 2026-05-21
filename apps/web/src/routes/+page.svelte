<script lang="ts">
  import { onMount } from 'svelte';
  import { t, locale } from 'svelte-i18n';
  import { getOrGenerateIdentity } from '../lib/identity';
  
  let identity = $state('');
  let nicknameInput = $state('');

  onMount(() => {
    // If an identity already exists in sessionStorage, auto-load it
    if (sessionStorage.getItem('alfajer_identity')) {
      identity = getOrGenerateIdentity();
    }
  });

  function handleLogin() {
    identity = getOrGenerateIdentity(nicknameInput);
  }

  function handleStartCall() {
    // Generate a secure pseudo-random room id
    const array = new Uint8Array(4);
    window.crypto.getRandomValues(array);
    const roomId = Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    
    // Redirect to room with init flag
    window.location.href = `/call/${roomId}?init=true`;
  }

  function toggleLanguage() {
    if ($locale?.startsWith('ar')) {
      $locale = 'en';
    } else {
      $locale = 'ar';
    }
  }
</script>

<div class="landing-page">
  <header>
    <h1>{$t('welcome')}</h1>
    <button onclick={toggleLanguage}>
      {$locale?.startsWith('ar') ? 'English' : 'عربي'}
    </button>
  </header>

  <div class="card">
    {#if !identity}
      <p>Enter a nickname to join (or click directly to remain anonymous)</p>
      <input type="text" placeholder={$t('nickname')} bind:value={nicknameInput} />
      <button onclick={handleLogin}>{$t('joinCall')}</button>
    {:else}
      <p>Your Identity: <strong>{identity}</strong></p>
      <button onclick={handleStartCall}>{$t('startCall')}</button>
    {/if}
  </div>
</div>

<style>
  .landing-page {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 2rem;
  }
  
  header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .card {
    background-color: var(--bg-secondary);
    padding-block: 2rem;
    padding-inline: 2rem;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 100%;
    max-width: 400px;
    box-shadow: 0 10px 15px -3px rgb(0 0 0 / 10%);
  }
</style>
