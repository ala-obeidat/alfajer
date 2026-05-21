import { addMessages, init, register, getLocaleFromNavigator } from 'svelte-i18n';
import ar from './ar.json';

// Synchronous load for Arabic (Default)
addMessages('ar', ar);

// Asynchronous dynamic import for English
register('en', () => import('./en.json'));

const browserLocale = typeof window !== 'undefined' ? getLocaleFromNavigator() : 'ar';
const initialLocale = browserLocale?.startsWith('en') ? 'en' : 'ar';

init({
  fallbackLocale: 'ar',
  initialLocale,
});
