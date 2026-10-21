import { configDefaults, defineConfig } from 'vitest/config';

// tests/ runs under `claude plugin test`; integrations/ packages use their own runners.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/**', 'integrations/**'],
  },
});
