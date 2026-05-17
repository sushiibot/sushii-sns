import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq, isNull, sql } from "drizzle-orm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import logger from "../../logger";
import {
  MonitorsConfig,
  ConnectionTypeSchema,
  FormatSchema,
  parseConnectionId,
  type Connection,
  type MonitorFormat,
} from "../config";
import { guildSettings, monitors, pendingReviews, posts } from "./schema";

const log = logger.child({ module: "monitor/db" });

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle/migrations");

export type LastFetch = {
  last_fetched_at: number;
  last_fetched_by: string;
};

export type PostPostedCheck =
  | { wasPosted: false; discordUrl: null }
  | { wasPosted: true; discordUrl: string };

export function openMetadataDb(path: string): BunSQLiteDatabase {
  const rawDb = new Database(path, { create: true });

  rawDb.exec("PRAGMA journal_mode=WAL;");
  const db = drizzle(rawDb);
  // FK must be off during migration — Drizzle's table-rebuild idiom re-creates tables and would trip cascade rules.
  rawDb.exec("PRAGMA foreign_keys=OFF;");
  try {
    migrate(db, { migrationsFolder });
  } catch (err) {
    log.error({ err, path, migrationsFolder }, "DB migration failed");
    rawDb.close();
    throw err;
  }
  rawDb.exec("PRAGMA foreign_keys=ON;");

  return db;
}

// ---------------------------------------------------------------------------
// Config — guild_settings + monitors
// ---------------------------------------------------------------------------

export function getMonitorsConfig(db: BunSQLiteDatabase, guildId: string): MonitorsConfig | null {
  const settings = db
    .select({
      panelChannelId: guildSettings.panelChannelId,
      panelMessageId: guildSettings.panelMessageId,
      socialsChannelId: guildSettings.socialsChannelId,
      triggerRoleId: guildSettings.triggerRoleId,
      format: guildSettings.format,
      template: guildSettings.template,
    })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, guildId))
    .get();

  if (!settings) return null;

  const rows = db
    .select({
      type: monitors.type,
      handle: monitors.handle,
      profileName: monitors.profileName,
    })
    .from(monitors)
    .where(eq(monitors.guildId, guildId))
    .orderBy(monitors.type, monitors.handle)
    .all();

  const connections: Connection[] = rows.flatMap((r) => {
    const typeParsed = ConnectionTypeSchema.safeParse(r.type);
    if (!typeParsed.success) {
      log.warn({ type: r.type, handle: r.handle }, "Skipping monitor row with unknown type");
      return [];
    }
    return [{
      type: typeParsed.data,
      handle: r.handle,
      profile_name: r.profileName ?? null,
    }];
  });

  const formatParsed = FormatSchema.safeParse(settings.format);
  if (!formatParsed.success) {
    log.warn({ format: settings.format, guildId }, "Unknown format value, defaulting to inline");
  }
  const format = formatParsed.success ? formatParsed.data : "inline";

  return new MonitorsConfig({
    panel_channel_id: settings.panelChannelId,
    panel_message_id: settings.panelMessageId ?? null,
    socials_channel_id: settings.socialsChannelId,
    trigger_role_id: settings.triggerRoleId ?? null,
    format,
    template: settings.template,
    connections,
  });
}

export type GuildChannelSettings = Pick<
  MonitorsConfig,
  "panel_channel_id" | "socials_channel_id" | "trigger_role_id"
>;

export function upsertGuildSettings(
  db: BunSQLiteDatabase,
  guildId: string,
  settings: GuildChannelSettings,
): void {
  db.insert(guildSettings)
    .values({
      guildId,
      panelChannelId: settings.panel_channel_id,
      socialsChannelId: settings.socials_channel_id,
      triggerRoleId: settings.trigger_role_id,
    })
    .onConflictDoUpdate({
      target: guildSettings.guildId,
      set: {
        panelChannelId: settings.panel_channel_id,
        socialsChannelId: settings.socials_channel_id,
        triggerRoleId: settings.trigger_role_id,
      },
    })
    .run();
}

export function updateGuildTemplate(
  db: BunSQLiteDatabase,
  guildId: string,
  format: MonitorFormat,
  template: string,
): void {
  db.update(guildSettings)
    .set({ format, template })
    .where(eq(guildSettings.guildId, guildId))
    .run();
}

export function updatePanelMessage(db: BunSQLiteDatabase, guildId: string, messageId: string): void {
  db.update(guildSettings)
    .set({ panelMessageId: messageId })
    .where(eq(guildSettings.guildId, guildId))
    .run();
}

export function addMonitor(db: BunSQLiteDatabase, guildId: string, connection: Connection): void {
  const insert = db.insert(monitors).values({
    guildId,
    type: connection.type,
    handle: connection.handle,
    profileName: connection.profile_name ?? null,
  });
  // On conflict: update profileName only when provided, otherwise leave existing name intact.
  if (connection.profile_name != null) {
    insert.onConflictDoUpdate({
      target: [monitors.guildId, monitors.type, monitors.handle],
      set: { profileName: connection.profile_name },
    }).run();
  } else {
    insert.onConflictDoNothing().run();
  }
}

export function setConnectionProfileName(
  db: BunSQLiteDatabase,
  guildId: string,
  connectionId: string,
  profileName: string | null,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.update(monitors)
    .set({ profileName })
    .where(
      and(
        eq(monitors.guildId, guildId),
        eq(monitors.type, parts.type),
        eq(monitors.handle, parts.handle),
      ),
    )
    .run();
}

export function removeMonitor(db: BunSQLiteDatabase, guildId: string, type: string, handle: string): void {
  db.delete(monitors)
    .where(
      and(
        eq(monitors.guildId, guildId),
        eq(monitors.type, type),
        eq(monitors.handle, handle),
      ),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Connection fetch state — last_fetched_at / last_fetched_by on monitors row
// ---------------------------------------------------------------------------

export function getConnectionMeta(
  db: BunSQLiteDatabase,
  guildId: string,
  connectionId: string,
): LastFetch | null {
  const parts = parseConnectionId(connectionId);
  if (!parts) return null;

  const row = db
    .select({
      lastFetchedAt: monitors.lastFetchedAt,
      lastFetchedBy: monitors.lastFetchedBy,
    })
    .from(monitors)
    .where(
      and(
        eq(monitors.guildId, guildId),
        eq(monitors.type, parts.type),
        eq(monitors.handle, parts.handle),
      ),
    )
    .get();

  if (!row || row.lastFetchedAt === null || row.lastFetchedBy === null) return null;
  return { last_fetched_at: row.lastFetchedAt, last_fetched_by: row.lastFetchedBy };
}

export function upsertConnectionMeta(
  db: BunSQLiteDatabase,
  guildId: string,
  connectionId: string,
  lastFetchedAt: number,
  lastFetchedBy: string,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.update(monitors)
    .set({ lastFetchedAt, lastFetchedBy })
    .where(
      and(
        eq(monitors.guildId, guildId),
        eq(monitors.type, parts.type),
        eq(monitors.handle, parts.handle),
      ),
    )
    .run();
}

export function purgeConnectionMeta(db: BunSQLiteDatabase, guildId: string, connectionId: string): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.update(monitors)
    .set({ lastFetchedAt: null, lastFetchedBy: null })
    .where(
      and(
        eq(monitors.guildId, guildId),
        eq(monitors.type, parts.type),
        eq(monitors.handle, parts.handle),
      ),
    )
    .run();
}

export function purgeAllConnectionMeta(db: BunSQLiteDatabase, guildId: string): void {
  db.update(monitors)
    .set({ lastFetchedAt: null, lastFetchedBy: null })
    .where(eq(monitors.guildId, guildId))
    .run();
}

// ---------------------------------------------------------------------------
// Posts — seen / posted deduplication
// ---------------------------------------------------------------------------

export function isPostSeen(
  db: BunSQLiteDatabase,
  guildId: string,
  connectionId: string,
  postId: string,
): boolean {
  const parts = parseConnectionId(connectionId);
  if (!parts) return false;

  const row = db
    .select({ x: sql`1` })
    .from(posts)
    .where(
      and(
        eq(posts.guildId, guildId),
        eq(posts.type, parts.type),
        eq(posts.handle, parts.handle),
        eq(posts.postId, postId),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

export function markPostSeen(
  db: BunSQLiteDatabase,
  guildId: string,
  connectionId: string,
  postId: string,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.insert(posts)
    .values({
      guildId,
      type: parts.type,
      handle: parts.handle,
      postId,
      seenAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

export function checkIfPostWasPublished(
  db: BunSQLiteDatabase,
  guildId: string,
  connectionId: string,
  postId: string,
): PostPostedCheck {
  const parts = parseConnectionId(connectionId);
  if (!parts) return { wasPosted: false, discordUrl: null };

  const row = db
    .select({ postedDiscordUrl: posts.postedDiscordUrl })
    .from(posts)
    .where(
      and(
        eq(posts.guildId, guildId),
        eq(posts.type, parts.type),
        eq(posts.handle, parts.handle),
        eq(posts.postId, postId),
      ),
    )
    .get();

  const discordUrl = row?.postedDiscordUrl ?? null;
  if (discordUrl !== null) return { wasPosted: true, discordUrl };
  return { wasPosted: false, discordUrl: null };
}

export function upsertPostedMessageTracking(
  db: BunSQLiteDatabase,
  guildId: string,
  connectionId: string,
  postId: string,
  discordUrl: string,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  const now = Date.now();
  db.insert(posts)
    .values({
      guildId,
      type: parts.type,
      handle: parts.handle,
      postId,
      seenAt: now,
      postedDiscordUrl: discordUrl,
    })
    .onConflictDoUpdate({
      target: [posts.guildId, posts.type, posts.handle, posts.postId],
      set: { postedDiscordUrl: discordUrl },
    })
    .run();
}

export function purgeConnectionSeenPosts(
  db: BunSQLiteDatabase,
  guildId: string,
  connectionId: string,
): void {
  const parts = parseConnectionId(connectionId);
  if (!parts) return;

  db.delete(posts)
    .where(
      and(
        eq(posts.guildId, guildId),
        eq(posts.type, parts.type),
        eq(posts.handle, parts.handle),
        isNull(posts.postedDiscordUrl),
      ),
    )
    .run();
}

export function purgeAllSeenPosts(db: BunSQLiteDatabase, guildId: string): void {
  db.delete(posts)
    .where(and(eq(posts.guildId, guildId), isNull(posts.postedDiscordUrl)))
    .run();
}

// ---------------------------------------------------------------------------
// Pending reviews
// ---------------------------------------------------------------------------

export type ReviewStatus = "pending" | "posted" | "skipped";

export type PendingReviewRow = {
  review_id: string;
  guild_id: string;
  connection_id: string;
  post_id: string;
  post_url: string;
  platform: string;
  username: string;
  original_text: string;
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
  status: ReviewStatus;
  posted_discord_url: string | null;
};

export type PendingReviewInsert = {
  reviewId: string;
  guildId: string;
  connectionId: string;
  postId: string;
  postUrl: string;
  platform: string;
  username: string;
  originalText: string;
  fileNames: string[];
  renderedContent: string;
  socialsChannelId: string;
  format: MonitorFormat;
  template: string;
  fetcherUserId: string;
};

export function insertPendingReview(db: BunSQLiteDatabase, r: PendingReviewInsert): void {
  db.insert(pendingReviews)
    .values({
      reviewId: r.reviewId,
      guildId: r.guildId,
      connectionId: r.connectionId,
      postId: r.postId,
      postUrl: r.postUrl,
      platform: r.platform,
      username: r.username,
      originalText: r.originalText,
      fileNames: JSON.stringify(r.fileNames),
      customContent: null,
      renderedContent: r.renderedContent,
      socialsChannelId: r.socialsChannelId,
      format: r.format,
      template: r.template,
      fetcherUserId: r.fetcherUserId,
      createdAt: Date.now(),
    })
    .run();
}

export function getPendingReview(db: BunSQLiteDatabase, reviewId: string): PendingReviewRow | null {
  const row = db
    .select()
    .from(pendingReviews)
    .where(eq(pendingReviews.reviewId, reviewId))
    .get();

  if (!row) return null;

  return {
    review_id: row.reviewId,
    guild_id: row.guildId,
    connection_id: row.connectionId,
    post_id: row.postId,
    post_url: row.postUrl,
    platform: row.platform,
    username: row.username,
    original_text: row.originalText,
    message_ids: row.messageIds,
    file_names: row.fileNames,
    removed_indices: row.removedIndices,
    custom_content: row.customContent,
    rendered_content: row.renderedContent,
    socials_channel_id: row.socialsChannelId,
    format: row.format,
    template: row.template,
    fetcher_user_id: row.fetcherUserId,
    created_at: row.createdAt,
    status: row.status as ReviewStatus,
    posted_discord_url: row.postedDiscordUrl,
  };
}

export function updatePendingReview(
  db: BunSQLiteDatabase,
  reviewId: string,
  updates: { removedIndices?: number[]; customContent?: string | null; messageIds?: string[] },
): void {
  const set: Partial<Pick<typeof pendingReviews.$inferInsert, "removedIndices" | "customContent" | "messageIds">> = {};

  if (updates.removedIndices !== undefined) {
    set.removedIndices = JSON.stringify(updates.removedIndices);
  }
  // Use `in` (not `!== undefined`) so explicit null passes through to set the column to NULL.
  if ("customContent" in updates) {
    set.customContent = updates.customContent ?? null;
  }
  if (updates.messageIds !== undefined) {
    set.messageIds = JSON.stringify(updates.messageIds);
  }

  if (Object.keys(set).length === 0) return;

  db.update(pendingReviews)
    .set(set)
    .where(eq(pendingReviews.reviewId, reviewId))
    .run();
}

export function deletePendingReview(db: BunSQLiteDatabase, reviewId: string): void {
  db.delete(pendingReviews).where(eq(pendingReviews.reviewId, reviewId)).run();
}

export function setReviewStatus(
  db: BunSQLiteDatabase,
  reviewId: string,
  status: Exclude<ReviewStatus, "pending">,
): boolean {
  const rows = db
    .update(pendingReviews)
    .set({ status })
    .where(and(eq(pendingReviews.reviewId, reviewId), eq(pendingReviews.status, "pending")))
    .returning({ reviewId: pendingReviews.reviewId })
    .all();
  return rows.length > 0;
}

export function setReviewPostedUrl(
  db: BunSQLiteDatabase,
  reviewId: string,
  postedDiscordUrl: string,
): void {
  db.update(pendingReviews)
    .set({ postedDiscordUrl })
    .where(eq(pendingReviews.reviewId, reviewId))
    .run();
}
