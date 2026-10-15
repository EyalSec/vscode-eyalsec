import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', '.vscode-test/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['src/test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
