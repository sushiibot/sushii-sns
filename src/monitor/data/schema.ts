// Breaking change from pre-v1 schema — delete data.db when upgrading.
// Each entry is an array of SQL statements for that migration version.
// On startup, runMigrations applies pending migrations in order and updates PRAGMA user_version.

export const METADATA_MIGRATIONS: string[][] = [
  // Migration 0 — multi-guild schema
  [

    `CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT NOT NULL PRIMARY KEY,
      panel_channel_id TEXT NOT NULL,
      panel_message_id TEXT,
      socials_channel_id TEXT NOT NULL,
      trigger_role_id TEXT,
      log_channel_id TEXT,
      format TEXT NOT NULL DEFAULT 'inline',
      template TEXT NOT NULL DEFAULT ''
    )`,

    `CREATE TABLE IF NOT EXISTS monitors (
      guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      handle TEXT NOT NULL,
      ig_id TEXT,
      cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      last_fetched_at INTEGER,
      last_fetched_by TEXT,
      PRIMARY KEY (guild_id, type, handle)
    )`,

    `CREATE TABLE IF NOT EXISTS posts (
      guild_id TEXT NOT NULL,
      type TEXT NOT NULL,
      handle TEXT NOT NULL,
      post_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      posted_message_id TEXT,
      PRIMARY KEY (guild_id, type, handle, post_id),
      FOREIGN KEY (guild_id, type, handle) REFERENCES monitors(guild_id, type, handle) ON DELETE CASCADE
    )`,
  ],

  // Migration 1 — profile display name cache
  [
    `ALTER TABLE monitors ADD COLUMN profile_name TEXT`,
  ],

  // Migration 2 — remove per-connection cooldown (hardcoded in handler)
  [
    `ALTER TABLE monitors DROP COLUMN cooldown_seconds`,
  ],
];
