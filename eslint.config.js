import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'],
  },
  {
    files: ['**/*.{js,ts}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // Functional style: use factory functions and plain objects instead of classes.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ClassDeclaration, ClassExpression',
          message:
            'Use factory functions and plain objects instead of classes.',
        },
      ],
    },
  },
  prettier,
)
