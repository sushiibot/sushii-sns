/**
 * Connection seed: fetch the current feed for a new connection, mark all items as seen,
 * and extract profile metadata. No media is downloaded.
 *
 * This is used when a connection is first added to validate the account exists and
 * to prevent the first poll from flooding the review queue with old content.
 */
import type { Connection } from "../config";
import { seedIgProfileFeed } from "./fetch/instagram";
import { seedTwitterFeed } from "./fetch/twitter";
import { seedTiktokFeed } from "./fetch/tiktok";

export type SeedResult = {
  count: number;
  profileName: string | null;
};

export async function seedConnection(
  connection: Connection,
  isPostSeen: (id: string) => boolean,
  markPostSeen: (id: string) => void,
): Promise<SeedResult> {
  if (connection.type === "instagram") {
    return seedIgProfileFeed(connection.handle, isPostSeen, markPostSeen);
  }
  if (connection.type === "twitter") {
    return seedTwitterFeed(connection.handle, isPostSeen, markPostSeen);
  }
  if (connection.type === "tiktok") {
    return seedTiktokFeed(connection.handle, isPostSeen, markPostSeen);
  }
  const _exhaustive: never = connection.type;
  throw new Error(`Unknown connection type: ${_exhaustive}`);
}
