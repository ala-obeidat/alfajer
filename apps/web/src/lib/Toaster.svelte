<script lang="ts">
  import { toast } from './toast.svelte';
  import { fly, fade } from 'svelte/transition';
</script>

<div class="toast-stack" role="status" aria-live="polite">
  {#each toast.list as t (t.id)}
    <button
      type="button"
      class="toast toast-{t.variant}"
      onclick={() => toast.dismiss(t.id)}
      in:fly={{ y: -20, duration: 200 }}
      out:fade={{ duration: 150 }}
    >
      {t.text}
    </button>
  {/each}
</div>

<style>
  .toast-stack {
    position: fixed;
    inset-block-start: max(env(safe-area-inset-top, 0px), 0.75rem);
    inset-inline-start: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    z-index: 9999;
    pointer-events: none;
    max-inline-size: min(90vw, 28rem);
  }

  .toast {
    pointer-events: auto;
    padding: 0.7rem 1rem;
    border-radius: 10px;
    color: white;
    background: rgba(30, 41, 59, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.12);
    backdrop-filter: blur(8px);
    font-size: 0.95rem;
    text-align: start;
    box-shadow: 0 10px 30px rgb(0 0 0 / 50%);
    cursor: pointer;
    transition: transform 0.1s ease;
  }

  .toast:hover { transform: scale(1.01); }
  .toast:active { transform: scale(0.99); }

  .toast-success { background: rgba(16, 185, 129, 0.95); border-color: rgba(16, 185, 129, 1); }
  .toast-warn    { background: rgba(245, 158, 11, 0.96); border-color: rgba(245, 158, 11, 1); }
  .toast-error   { background: rgba(239, 68, 68, 0.96);  border-color: rgba(239, 68, 68, 1); }
</style>
