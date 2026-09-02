import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration023: Migration = {
  version: 23,
  name: 'transcript-rotate-days',
  up(db: Database.Database) {
    // NULL keeps the runner's built-in default, so existing groups are unchanged.
    db.prepare('ALTER TABLE container_configs ADD COLUMN transcript_rotate_days INTEGER').run();
  },
};
