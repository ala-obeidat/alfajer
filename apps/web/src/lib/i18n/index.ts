import { addMessages, init } from 'svelte-i18n';
import en from './en.json';

// English-only build — the Arabic locale and language picker were removed
// (the ar.json file is left on disk for future re-enablement).
addMessages('en', en);

init({
  fallbackLocale: 'en',
  initialLocale: 'en',
});
