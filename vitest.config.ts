import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts', 'container/*.test.ts'],
    // Live-server integration tests hit a real Matrix homeserver with a real
    // throwaway account — never run as part of the default suite. Run
    // explicitly via `pnpm test:matrix-live`.
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
  },
});
