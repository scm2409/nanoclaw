import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'show-token-usage',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN show_token_usage INTEGER').run();
  },
};
