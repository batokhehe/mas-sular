import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// Next.js 16 flat config (next lint was removed in 16), as in Next's ESLint docs.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Reported, not blocking: this code predates linting in CI. The React Compiler rules
    // that ship as errors in eslint-plugin-react-hooks 7 flag existing effects that
    // need a deliberate refactor, and `any` is a warning in the backend too.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);
