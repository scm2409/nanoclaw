import type Database from 'better-sqlite3';
import { RUN_HEALTH_SCHEMA } from '../../modules/scheduling/run-health.js';
import type { Migration } from './index.js';

export const migration022: Migration = {
  version: 22,
  name: 'task-run-health',
  up(db: Database.Database) {
    db.exec(RUN_HEALTH_SCHEMA);
  },
};
