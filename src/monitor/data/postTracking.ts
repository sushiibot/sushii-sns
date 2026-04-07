/**
 * Contract for recording that a post was sent to the socials channel (posts table).
 * Used by {@link sendPostToChannel} without importing SQLite from utils.
 */
export interface PostTrackingSink {
  recordPosted(
    guildId: string,
    connectionId: string,
    postId: string,
    discordMessageId: string,
  ): void;
}
