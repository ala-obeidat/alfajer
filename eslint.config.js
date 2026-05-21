import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ["**/.svelte-kit/**", "**/dist/**", "**/build/**"]
  },
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    }
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='margin-left'], Property[key.name='margin-right'], Property[key.name='padding-left'], Property[key.name='padding-right'], Property[key.name='left'], Property[key.name='right']",
          message: 'Do not use physical CSS properties. Use logical properties like margin-inline-start instead.'
        }
      ]
    }
  }
];
