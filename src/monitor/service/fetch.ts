/**
 * Monitor polling: orchestrates provider fetch modules (list + hydrate), DB seen state,
 * review creation, and `/fetch-all` sync.
 */
import logger from "../../logger";
import { getFileExtFromURL } from "../../utils/http";
import { convertHeicToJpeg } from "../../utils/heic";
import type { AnySnsMetadata, PostData } from "../../platforms/base";
import type { Connection } from "../config";
import { getConnectionId } from "../config";
import type { MonitorRepository } from "../data/repository";
import { fetchInstagramConnectionPosts } from "./fetch/instagram";
import { fetchTiktokFeed } from "./fetch/tiktok";
import { fetchTwitterFeedRapidApi } from "./fetch/twitter";

/** Media download helper injected from the monitor orchestrator (HEIC conversion, etc.). */
export type DownloadFilesFromUrls = (urls: string[]) => Promise<
  { ext: string; buffer: Buffer }[]
>;

/**
 * Filter to unseen items and take the first `limit`, but do NOT mark them seen.
 * Use this when the caller needs to mark each item seen only after successful hydration.
 * A `limit` of 0 or less (including negative values) means no limit — all unseen items are returned.
 */
export function selectUnseenSlice<T>(
  items: T[],
  getId: (t: T) => string,
  isPostSeen: ((id: string) => boolean) | undefined,
  limit: number,
): T[] {
  const unseen = items.filter((item) => {
    const id = getId(item);
    if (!id) return false;
    // if isPostSeen is not provided, treat all items as unseen
    return !isPostSeen?.(id);
  });
  return limit > 0 && isFinite(limit) ? unseen.slice(0, limit) : unseen;
}

const log = logger.child({ module: "monitor/fetch" });

export async function downloadFilesFromUrls(urls: string[]) {
  const buffers = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to download media (${res.status}): ${url}`);
      }
      return Buffer.from(await res.arrayBuffer());
    }),
  );

  return convertHeicToJpeg(
    buffers.map((buf, i) => ({
      ext: getFileExtFromURL(urls[i]),
      buffer: buf,
    })),
  );
}

/**
 * Fetches posts for a single connection using the appropriate platform fetcher.
 * Handles the instagram/tiktok/twitter dispatch logic shared by poll and fetch-all.
 */
export async function fetchConnectionPosts(
  connection: Connection,
  downloadFn: DownloadFilesFromUrls,
  seenOpts: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit: number;
    storiesLimit?: number;
    storiesMarkSeenOnly?: boolean;
    profileMarkSeenOnly?: boolean;
    markSeenOnly?: boolean;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  if (connection.type === "instagram") {
    const igOpts = {
      ...seenOpts,
      profileMarkSeenOnly: seenOpts.profileMarkSeenOnly ?? seenOpts.markSeenOnly ?? false,
    };
    return fetchInstagramConnectionPosts(connection.handle, downloadFn, igOpts);
  } else if (connection.type === "tiktok") {
    return fetchTiktokFeed(connection.handle, downloadFn, {
      ...seenOpts,
      markSeenOnly: seenOpts.markSeenOnly ?? false,
    });
  } else if (connection.type === "twitter") {
    return fetchTwitterFeedRapidApi(connection.handle, downloadFn, {
      ...seenOpts,
      markSeenOnly: seenOpts.markSeenOnly ?? false,
    });
  } else {
    const _exhaustive: never = connection.type; // TypeScript will error if a new ConnectionType is added
    log.warn({ type: _exhaustive }, "Unknown connection type in fetchConnectionPosts — no posts fetched");
    return [];
  }
}

/**
 * Polls every monitor connection: marks all current feed/story items as seen without
 * creating review messages or downloading media (except API calls required to list items).
 * Updates last-fetch metadata per connection.
 */
export async function syncAllMonitorConnections(
  guildId: string,
  connections: Connection[],
  monitorRepo: MonitorRepository,
  opts?: { lastFetchedBy?: string; lastFetchedByName?: string | null },
): Promise<void> {
  const lastFetchedBy = opts?.lastFetchedBy ?? "fetch-all";
  const lastFetchedByName = opts?.lastFetchedByName ?? null;
  const now = Date.now();

  for (const connection of connections) {
    const connectionId = getConnectionId(connection);

    const shared = {
      isPostSeen: (id: string) => monitorRepo.isPostSeen(guildId, connectionId, id),
      markPostSeen: (id: string) => monitorRepo.markPostSeen(guildId, connectionId, id),
    };

    try {
      await fetchConnectionPosts(connection, downloadFilesFromUrls, {
        ...shared,
        limit: 0,
        markSeenOnly: true,
        storiesMarkSeenOnly: true,
      });

      monitorRepo.upsertConnectionMeta(guildId, connectionId, now, lastFetchedBy, lastFetchedByName);
    } catch (err) {
      log.error({ err, connectionId }, "fetch-all: connection sync failed");
    }
  }
}
