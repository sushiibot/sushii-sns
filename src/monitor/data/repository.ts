import type { Database } from "bun:sqlite";
import type { Connection, MonitorsConfig } from "../config";
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
  type GuildChannelSettings,
  type LastFetch,
  type PostPostedCheck,
} from "./queries";

export type { LastFetch, PostPostedCheck };

/**
 * Monitor persistence: guild config, per-connection fetch state, seen/post rows.
 * All methods are scoped to a guildId. Implementations hide SQLite; callers do not use Database directly.
 */
export interface MonitorRepository extends PostTrackingSink {
  // Config
  getConfig(guildId: string): MonitorsConfig | null;
  upsertSettings(guildId: string, settings: GuildChannelSettings): void;
  updateTemplate(guildId: string, format: "inline" | "links", template: string): void;
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
}

export function createMonitorRepository(db: Database): MonitorRepository {
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
  };
}
