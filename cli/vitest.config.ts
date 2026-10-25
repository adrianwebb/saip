import { defineConfig } from 'vitest/config'

// #138: no package's suite may depend on the developer's shell being free of SAIP_* variables.
export default defineConfig({
  test: {
    setupFiles: ['../tools/vitest/env-isolation.ts'],
  },
})
