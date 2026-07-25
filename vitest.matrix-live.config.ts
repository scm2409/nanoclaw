import { defineConfig } from 'vitest/config';

// Separate config for the live-server Matrix integration suite — run only
// via `pnpm test:matrix-live`, never picked up by `pnpm test` (which
// excludes *.live.test.ts in vitest.config.ts). Kept as its own config
// rather than a CLI override so the exclusion in the default config can't
// be accidentally bypassed by a stray `vitest run <pattern>` invocation.
export default defineConfig({
  test: {
    include: ['src/channels/matrix.live.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
