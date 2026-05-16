import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Connection, MonitorsConfig, MonitorFormat } from "../config";
import { FormatSchema } from "../config";
import type { PostTrackingSink } from "./postTracking";
import {
  addMonitor,
  checkIfPostWasPublished,
  getConnectionMeta,
  getMonitorsConfig,
  isPostSeen,
  markPostSeen,
  purgeAllConnectionMeta,
  purgeAllSeenPosts,
  purgeConnectionMeta,
  purgeConnectionSeenPosts,
  removeMonitor,
  setConnectionProfileName,
  updatePanelMessage,
  upsertConnectionMeta,
  upsertGuildSettings,
  updateGuildTemplate,
  upsertPostedMessageTracking,
  insertPendingReview,
  getPendingReview,
  updatePendingReview,
  deletePendingReview,
  type GuildChannelSettings,
  type LastFetch,
  type PostPostedCheck,
  type PendingReviewInsert,
  type PendingReviewRow,
} from "./queries";
import type { ReviewState } from "../service/review/types";

export type { LastFetch, PostPostedCheck, PendingReviewInsert, GuildChannelSettings };

function safeParseArray<T>(json: string, fallback: T[]): T[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function rowToReviewState(row: PendingReviewRow): ReviewState {
  const fileNames: string[] = safeParseArray(row.file_names, []);
  const messageIds: string[] = safeParseArray(row.message_ids, []);
  const removedIndicesArr: number[] = safeParseArray(row.removed_indices, []);

  const formatParsed = FormatSchema.safeParse(row.format);
  const format = formatParsed.success ? formatParsed.data : "inline";

  return {
    postData: {
      postID: row.post_id,
      username: "",
      postLink: { url: "", metadata: { platform: row.connection_id.split(":")[0] } as any },
      files: fileNames.map((name) => ({ ext: name.split(".").pop() || "bin", buffer: Buffer.alloc(0) })),
      originalText: "",
    },
    guildId: row.guild_id,
    connectionId: row.connection_id,
    removedIndices: new Set(removedIndicesArr),
    customContent: row.custom_content,
    renderedContent: row.rendered_content,
    socialsChannelId: row.socials_channel_id,
    format,
    template: row.template,
    fetcherUserId: row.fetcher_user_id,
    fileNames,
    messageIds,
  };
}

/**
 * Monitor persistence: guild config, per-connection fetch state, seen/post rows.
 * All methods are scoped to a guildId. Implementations hide SQLite; callers do not use Database directly.
 */
export interface MonitorRepository extends PostTrackingSink {
  // Config
  getConfig(guildId: string): MonitorsConfig | null;
  upsertSettings(guildId: string, settings: GuildChannelSettings): void;
  updateTemplate(guildId: string, format: MonitorFormat, template: string): void;
  updatePanelMessage(guildId: string, messageId: string): void;
  addMonitor(guildId: string, connection: Connection): void;
  removeMonitor(guildId: string, type: string, handle: string): void;
  setProfileName(guildId: string, connectionId: string, profileName: string | null): void;

  // Fetch state
  getConnectionMeta(guildId: string, connectionId: string): LastFetch | null;
  upsertConnectionMeta(guildId: string, connectionId: string, lastFetchedAt: number, lastFetchedBy: string): void;
  purgeConnectionMeta(guildId: string, connectionId: string): void;
  purgeAllConnectionMeta(guildId: string): void;

  // Post deduplication
  isPostSeen(guildId: string, connectionId: string, postId: string): boolean;
  markPostSeen(guildId: string, connectionId: string, postId: string): void;
  purgeConnectionSeenPosts(guildId: string, connectionId: string): void;
  purgeAllSeenPosts(guildId: string): void;
  checkIfPostWasPublished(guildId: string, connectionId: string, postId: string): PostPostedCheck;

  // Pending reviews
  insertPendingReview(r: PendingReviewInsert): void;
  getPendingReview(reviewId: string): ReviewState | null;
  updatePendingReview(reviewId: string, updates: { removedIndices?: number[]; customContent?: string | null; messageIds?: string[] }): void;
  deletePendingReview(reviewId: string): void;
}

export function createMonitorRepository(db: BunSQLiteDatabase): MonitorRepository {
  return {
    recordPosted(guildId, connectionId, postId, discordMessageId) {
      upsertPostedMessageTracking(db, guildId, connectionId, postId, discordMessageId);
    },

    getConfig(guildId) {
      return getMonitorsConfig(db, guildId);
    },
    upsertSettings(guildId, settings) {
      upsertGuildSettings(db, guildId, settings);
    },
    updateTemplate(guildId, format, template) {
      updateGuildTemplate(db, guildId, format, template);
    },
    updatePanelMessage(guildId, messageId) {
      updatePanelMessage(db, guildId, messageId);
    },
    addMonitor(guildId, connection) {
      addMonitor(db, guildId, connection);
    },
    removeMonitor(guildId, type, handle) {
      removeMonitor(db, guildId, type, handle);
    },
    setProfileName(guildId, connectionId, profileName) {
      setConnectionProfileName(db, guildId, connectionId, profileName);
    },

    getConnectionMeta(guildId, connectionId) {
      return getConnectionMeta(db, guildId, connectionId);
    },
    upsertConnectionMeta(guildId, connectionId, lastFetchedAt, lastFetchedBy) {
      upsertConnectionMeta(db, guildId, connectionId, lastFetchedAt, lastFetchedBy);
    },
    purgeConnectionMeta(guildId, connectionId) {
      purgeConnectionMeta(db, guildId, connectionId);
    },
    purgeAllConnectionMeta(guildId) {
      purgeAllConnectionMeta(db, guildId);
    },

    isPostSeen(guildId, connectionId, postId) {
      return isPostSeen(db, guildId, connectionId, postId);
    },
    markPostSeen(guildId, connectionId, postId) {
      markPostSeen(db, guildId, connectionId, postId);
    },
    purgeConnectionSeenPosts(guildId, connectionId) {
      purgeConnectionSeenPosts(db, guildId, connectionId);
    },
    purgeAllSeenPosts(guildId) {
      purgeAllSeenPosts(db, guildId);
    },
    checkIfPostWasPublished(guildId, connectionId, postId) {
      return checkIfPostWasPublished(db, guildId, connectionId, postId);
    },

    insertPendingReview(r) {
      insertPendingReview(db, r);
    },
    getPendingReview(reviewId) {
      const row = getPendingReview(db, reviewId);
      if (!row) return null;
      return rowToReviewState(row);
    },
    updatePendingReview(reviewId, updates) {
      updatePendingReview(db, reviewId, updates);
    },
    deletePendingReview(reviewId) {
      deletePendingReview(db, reviewId);
    },
  };
}
