<script lang="ts">
  import { locale } from 'svelte-i18n';
  import '../lib/i18n';
  import '../app.css';
  import { onMount } from 'svelte';
  
  let { children } = $props();

  onMount(async () => {
    // We import dynamically to avoid SSR issues
    const pwaModule = await import('virtual:pwa-register');
    const registerSW = pwaModule.registerSW;
    if (registerSW) {
      registerSW({
        immediate: true
      });
    }
  });

  $effect(() => {
    if (typeof document !== 'undefined' && $locale) {
      document.documentElement.lang = $locale;
      document.documentElement.dir = $locale.startsWith('ar') ? 'rtl' : 'ltr';
    }
  });
</script>

<svelte:head>
  <title>Alfajer</title>
</svelte:head>

<main class="app-container">
  {@render children()}
</main>
