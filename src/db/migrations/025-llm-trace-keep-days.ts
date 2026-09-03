import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration025: Migration = {
  version: 25,
  name: 'llm-trace-keep-days',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN llm_trace_keep_days INTEGER').run();
  },
};
