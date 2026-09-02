import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration024: Migration = {
  version: 24,
  name: 'llm-trace',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN llm_trace INTEGER').run();
  },
};
