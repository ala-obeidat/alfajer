<script lang="ts">
  import '../lib/i18n';
  import '../app.css';
  import { onMount } from 'svelte';
  import Toaster from '$lib/Toaster.svelte';
  import { theme } from '$lib/theme.svelte';
  import { install } from '$lib/install.svelte';

  let { children } = $props();

  onMount(async () => {
    // Resolve dark/light/auto and apply data-theme on <html>.
    theme.init();
    // Listen for the install-eligibility event so the home page can offer it.
    install.init();

    // Register the service worker (PWA + offline shell).
    const pwaModule = await import('virtual:pwa-register');
    const registerSW = pwaModule.registerSW;
    if (registerSW) {
      registerSW({ immediate: true });
    }
  });
</script>

<svelte:head>
  <title>Alfajer</title>
</svelte:head>

<main class="app-container">
  {@render children()}
</main>

<Toaster />
