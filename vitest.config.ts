import { configDefaults, defineConfig } from 'vitest/config';

// tests/ runs under `claude plugin test` rather than Vitest.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/**'],
  },
});
