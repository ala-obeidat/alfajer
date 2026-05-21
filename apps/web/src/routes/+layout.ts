import { waitLocale } from 'svelte-i18n';
import '$lib/i18n';

export const prerender = true;
export const ssr = false;

export async function load() {
  await waitLocale();
}
