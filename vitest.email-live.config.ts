import { defineConfig } from 'vitest/config';

// Separate config for the email channel's live suite — run only via
// `pnpm test:email-live`, never picked up by `pnpm test` (which excludes
// *.live.test.ts). Needs a local GreenMail server: `scripts/greenmail.sh up`.
//
// EMAIL_STATE_DIR is set here rather than inside the test because
// email-state.ts resolves it at module load, and ESM imports are hoisted
// above any assignment the test file could make. Pointing it at a scratch
// directory keeps the suite from touching the real install's UID watermark.
export default defineConfig({
  test: {
    include: ['src/channels/email.live.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      EMAIL_STATE_DIR: '/tmp/nanoclaw-email-live-state',
    },
  },
});
