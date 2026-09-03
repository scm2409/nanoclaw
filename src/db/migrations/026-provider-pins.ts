import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration026: Migration = {
  version: 26,
  name: 'provider-pins',
  up(db: Database.Database) {
    // Keyed by model rather than by agent group: the cheapest tier is a
    // property of the model, and groups sharing a model share the snapshot.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS provider_pins (
         model TEXT PRIMARY KEY,
         providers TEXT NOT NULL,
         cheapest_price REAL NOT NULL,
         refreshed_at TEXT NOT NULL
       )`,
    ).run();
  },
};
