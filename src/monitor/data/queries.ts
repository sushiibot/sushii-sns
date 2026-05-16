import { Database } from "bun:sqlite";
import logger from "../../logger";
import { MonitorsConfig, ConnectionTypeSchema, FormatSchema, parseConnectionId, type Connection, type MonitorFormat } from "../config";
import { METADATA_MIGRATIONS } from "./schema";

const log = logger.child({ module: "monitor/db" });

export type LastFetch = {
  last_fetched_at: number;
  last_fetched_by: string;
};

export type PostPostedCheck =
  | { wasPosted: false; messageId: null }
  | { wasPosted: true; messageId: string };

function runMigrations(db: Database, migrations: string[][]): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  const currentVersion = row.user_version;

  const migrate = db.transaction((sqls: string[], version: number) => {
    for (const sql of sqls) {
      db.exec(sql);
    }
    // PRAGMA cannot use parameterized queries; version is always an array index (integer)
    db.exec(`PRAGMA user_version = ${version}`);
  });

  for (let i = currentVersion; i < migrations.length; i++) {
    log.info({ version: i }, "Running DB migration");
    migrate(migrations[i], i + 1);
  }
}

export function openMetadataDb(path: string): Database {
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  runMigrations(db, METADATA_MIGRATIONS);

  return db;
}

// ---------------------------------------------------------------------------
// Config — guild_settings + monitors
// ---------------------------------------------------------------------------

type GuildSettingsRow = {
  panel_channel_id: string;
  panel_message_id: string | null;
  socials_channel_id: string;
  trigger_role_id: string | null;
  log_channel_id: string | null;
  format: string;
  template: string;
};

type MonitorRow = {
  type: string;
  handle: string;
  profile_name: string | null;
};

export function getMonitorsConfig(db: Database, guildId: string): MonitorsConfig | null {
  const settings = db
    .query<GuildSettingsRow, [string]>(
      `SELECT panel_channel_id, panel_message_id, socials_channel_id,
              trigger_role_id, log_channel_id, format, template
       FROM guild_settings WHERE guild_id = ?`,
    )
    .get(guildId);

  if (!settings) return null;

  const rows = db
    .query<MonitorRow, [string]>(
      `SELECT type, handle, profile_name
       FROM monitors WHERE guild_id = ? ORDER BY type, handle`,
    )
    .all(guildId);

  const connections: Connection[] = rows.flatMap((r) => {
    const typeParsed = ConnectionTypeSchema.safeParse(r.type);
    if (!typeParsed.success) {
      log.warn({ type: r.type, handle: r.handle }, "Skipping monitor row with unknown type");
      return [];
    }
    return [{
      type: typeParsed.data,
      handle: r.handle,
      profile_name: r.profile_name ?? null,
    }];
  });

  const formatParsed = FormatSchema.safeParse(settings.format);
  const format = formatParsed.success ? formatParsed.data : "inline";

  return new MonitorsConfig({
    panel_channel_id: settings.panel_channel_id,
    panel_message_id: settings.panel_message_id ?? null,
    socials_channel_id: settings.socials_channel_id,
    trigger_role_id: settings.trigger_role_id ?? null,
    log_channel_id: settings.log_channel_id ?? null,
    format,
    template: settings.template,
    connections,
  });
}

export type GuildChannelSettings = Pick<
  MonitorsConfig,
  "panel_channel_id" | "socials_channel_id" | "trigger_role_id" | "log_channel_id"
>;

export function upsertGuildSettings(
  db: Database,
  guildId: string,
  settings: GuildChannelSettings,
): void {
  db.query(
    `INSERT INTO guild_settings
       (guild_id, panel_channel_id, socials_channel_id, trigger_role_id, log_channel_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET
       panel_channel_id   = excluded.panel_channel_id,
       socials_channel_id = excluded.socials_channel_id,
       trigger_role_id    = excluded.trigger_role_id,
       log_channel_id     = excluded.log_channel_id`,
  ).run(
    guildId,
    settings.panel_channel_id,
    settings.socials_channel_id,
    settings.trigger_role_id,
    settings.log_channel_id,
  );
}

export function updateGuildTemplate(
  db: Database,
  guildId: string,
  format: MonitorFormat,
  template: string,
): void {
  db.query(
    `UPDATE guild_settings SET format = ?, template = ? WHERE guild_id = ?`,
  ).run(format, template, guildId);
}

export function updatePanelMessage(db: Database, guildId: string, messageId: string): void {
  db.query(
    `UPDATE guild_settings SET panel_message_id = ? WHERE guild_id = ?`,
  ).run(messageId, guildId);
}

export function addMonitor(db: Database, guildId: string, connection: Connection): void {
  db.query(
    `INSERT INTO monitors (guild_id, type, handle, profile_name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, type, handle) DO UPDATE SET
       profile_name = excluded.profile_name`,
  ).run(guildId, connection.type, connection.handle, connection.profile_name ?? null);
}

export function setConnectionProfileName(
  db: Database,
  guildId: string,
  connectionId: string,
  profileName: string | null,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.query(
    `UPDATE monitors SET profile_name = ? WHERE guild_id = ? AND type = ? AND handle = ?`,
  ).run(profileName, guildId, parts.type, parts.handle);
}

export function removeMonitor(db: Database, guildId: string, type: string, handle: string): void {
  db.query(
    `DELETE FROM monitors WHERE guild_id = ? AND type = ? AND handle = ?`,
  ).run(guildId, type, handle);
}

// ---------------------------------------------------------------------------
// Connection fetch state — last_fetched_at / last_fetched_by on monitors row
// ---------------------------------------------------------------------------

export function getConnectionMeta(
  db: Database,
  guildId: string,
  connectionId: string,
): LastFetch | null {
  const parts = parseConnectionId(connectionId);
  if (!parts) return null;

  const row = db
    .query<{ last_fetched_at: number | null; last_fetched_by: string | null }, [string, string, string]>(
      `SELECT last_fetched_at, last_fetched_by FROM monitors
       WHERE guild_id = ? AND type = ? AND handle = ?`,
    )
    .get(guildId, parts.type, parts.handle);

  if (!row || row.last_fetched_at === null || row.last_fetched_by === null) return null;
  return { last_fetched_at: row.last_fetched_at, last_fetched_by: row.last_fetched_by };
}

export function upsertConnectionMeta(
  db: Database,
  guildId: string,
  connectionId: string,
  lastFetchedAt: number,
  lastFetchedBy: string,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.query(
    `UPDATE monitors SET last_fetched_at = ?, last_fetched_by = ?
     WHERE guild_id = ? AND type = ? AND handle = ?`,
  ).run(lastFetchedAt, lastFetchedBy, guildId, parts.type, parts.handle);
}

export function purgeConnectionMeta(db: Database, guildId: string, connectionId: string): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.query(
    `UPDATE monitors SET last_fetched_at = NULL, last_fetched_by = NULL
     WHERE guild_id = ? AND type = ? AND handle = ?`,
  ).run(guildId, parts.type, parts.handle);
}

export function purgeAllConnectionMeta(db: Database, guildId: string): void {
  db.query(
    `UPDATE monitors SET last_fetched_at = NULL, last_fetched_by = NULL WHERE guild_id = ?`,
  ).run(guildId);
}

// ---------------------------------------------------------------------------
// Posts — seen / posted deduplication
// ---------------------------------------------------------------------------

export function isPostSeen(
  db: Database,
  guildId: string,
  connectionId: string,
  postId: string,
): boolean {
  const parts = parseConnectionId(connectionId);
  if (!parts) return false;

  const row = db
    .query<{ count: number }, [string, string, string, string]>(
      `SELECT COUNT(*) as count FROM posts
       WHERE guild_id = ? AND type = ? AND handle = ? AND post_id = ?`,
    )
    .get(guildId, parts.type, parts.handle, postId);
  return (row?.count ?? 0) > 0;
}

export function markPostSeen(
  db: Database,
  guildId: string,
  connectionId: string,
  postId: string,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.query(
    `INSERT OR IGNORE INTO posts (guild_id, type, handle, post_id, seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(guildId, parts.type, parts.handle, postId, Date.now());
}

export function checkIfPostWasPublished(
  db: Database,
  guildId: string,
  connectionId: string,
  postId: string,
): PostPostedCheck {
  const parts = parseConnectionId(connectionId);
  if (!parts) return { wasPosted: false, messageId: null };

  const row = db
    .query<{ posted_message_id: string | null }, [string, string, string, string]>(
      `SELECT posted_message_id FROM posts
       WHERE guild_id = ? AND type = ? AND handle = ? AND post_id = ?`,
    )
    .get(guildId, parts.type, parts.handle, postId);

  const messageId = row?.posted_message_id ?? null;
  if (messageId !== null) return { wasPosted: true as const, messageId };
  return { wasPosted: false as const, messageId: null };
}

export function upsertPostedMessageTracking(
  db: Database,
  guildId: string,
  connectionId: string,
  postId: string,
  discordMessageId: string,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.query(
    `INSERT INTO posts (guild_id, type, handle, post_id, seen_at, posted_message_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, type, handle, post_id) DO UPDATE SET
       seen_at           = excluded.seen_at,
       posted_message_id = excluded.posted_message_id`,
  ).run(guildId, parts.type, parts.handle, postId, Date.now(), discordMessageId);
}

export function purgeConnectionSeenPosts(
  db: Database,
  guildId: string,
  connectionId: string,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.query(
    `DELETE FROM posts
     WHERE guild_id = ? AND type = ? AND handle = ? AND posted_message_id IS NULL`,
  ).run(guildId, parts.type, parts.handle);
}

export function purgeAllSeenPosts(db: Database, guildId: string): void {
  db.query(`DELETE FROM posts WHERE guild_id = ?`).run(guildId);
}

// ---------------------------------------------------------------------------
// Pending reviews
// ---------------------------------------------------------------------------

export type PendingReviewRow = {
  review_id: string;
  guild_id: string;
  connection_id: string;
  post_id: string;
  message_ids: string;      // JSON string array
  file_names: string;       // JSON string array
  removed_indices: string;  // JSON number array
  custom_content: string | null;
  rendered_content: string;
  socials_channel_id: string;
  format: string;
  template: string;
  fetcher_user_id: string;
  created_at: number;
};

export type PendingReviewInsert = {
  reviewId: string;
  guildId: string;
  connectionId: string;
  postId: string;
  fileNames: string[];
  renderedContent: string;
  socialsChannelId: string;
  format: string;
  template: string;
  fetcherUserId: string;
};

export function insertPendingReview(db: Database, r: PendingReviewInsert): void {
  db.query(
    `INSERT INTO pending_reviews
       (review_id, guild_id, connection_id, post_id, message_ids, file_names,
        removed_indices, custom_content, rendered_content, socials_channel_id,
        format, template, fetcher_user_id, created_at)
     VALUES (?, ?, ?, ?, '[]', ?, '[]', NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.reviewId,
    r.guildId,
    r.connectionId,
    r.postId,
    JSON.stringify(r.fileNames),
    r.renderedContent,
    r.socialsChannelId,
    r.format,
    r.template,
    r.fetcherUserId,
    Date.now(),
  );
}

export function getPendingReview(db: Database, reviewId: string): PendingReviewRow | null {
  return db
    .query<PendingReviewRow, [string]>(
      `SELECT review_id, guild_id, connection_id, post_id, message_ids, file_names,
              removed_indices, custom_content, rendered_content, socials_channel_id,
              format, template, fetcher_user_id, created_at
       FROM pending_reviews WHERE review_id = ?`,
    )
    .get(reviewId) ?? null;
}

export function updatePendingReview(
  db: Database,
  reviewId: string,
  updates: { removedIndices?: number[]; customContent?: string | null; messageIds?: string[] },
): void {
  const setClauses: string[] = [];
  const values: (string | null)[] = [];

  if (updates.removedIndices !== undefined) {
    setClauses.push("removed_indices = ?");
    values.push(JSON.stringify(updates.removedIndices));
  }
  if ("customContent" in updates) {
    setClauses.push("custom_content = ?");
    values.push(updates.customContent ?? null);
  }
  if (updates.messageIds !== undefined) {
    setClauses.push("message_ids = ?");
    values.push(JSON.stringify(updates.messageIds));
  }

  if (setClauses.length === 0) return;

  values.push(reviewId);
  db.query(`UPDATE pending_reviews SET ${setClauses.join(", ")} WHERE review_id = ?`).run(...values);
}

export function deletePendingReview(db: Database, reviewId: string): void {
  db.query(`DELETE FROM pending_reviews WHERE review_id = ?`).run(reviewId);
}
