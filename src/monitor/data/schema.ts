import { foreignKey, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const guildSettings = sqliteTable("guild_settings", {
  guildId: text("guild_id").notNull().primaryKey(),
  panelChannelId: text("panel_channel_id").notNull(),
  panelMessageId: text("panel_message_id"),
  socialsChannelId: text("socials_channel_id").notNull(),
  triggerRoleId: text("trigger_role_id"),
  format: text("format").notNull().default("inline"),
  template: text("template").notNull().default(""),
});

export const monitors = sqliteTable(
  "monitors",
  {
    guildId: text("guild_id").notNull(),
    type: text("type").notNull(),
    handle: text("handle").notNull(),
    igId: text("ig_id"),
    lastFetchedAt: integer("last_fetched_at"),
    lastFetchedBy: text("last_fetched_by"),
    profileName: text("profile_name"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.type, table.handle] }),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guildSettings.guildId],
    }).onDelete("cascade"),
  ],
);

export const posts = sqliteTable(
  "posts",
  {
    guildId: text("guild_id").notNull(),
    type: text("type").notNull(),
    handle: text("handle").notNull(),
    postId: text("post_id").notNull(),
    seenAt: integer("seen_at").notNull(),
    postedDiscordUrl: text("posted_discord_url"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.type, table.handle, table.postId] }),
    foreignKey({
      columns: [table.guildId, table.type, table.handle],
      foreignColumns: [monitors.guildId, monitors.type, monitors.handle],
    }).onDelete("cascade"),
  ],
);

export const pendingReviews = sqliteTable("pending_reviews", {
  reviewId: text("review_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  connectionId: text("connection_id").notNull(),
  postId: text("post_id").notNull(),
  postUrl: text("post_url").notNull(),
  platform: text("platform").notNull(),
  username: text("username").notNull().default(""),
  originalText: text("original_text").notNull().default(""),
  messageIds: text("message_ids").notNull().default("[]"),
  fileNames: text("file_names").notNull().default("[]"),
  removedIndices: text("removed_indices").notNull().default("[]"),
  customContent: text("custom_content"),
  renderedContent: text("rendered_content").notNull(),
  socialsChannelId: text("socials_channel_id").notNull(),
  format: text("format").notNull(),
  template: text("template").notNull(),
  fetcherUserId: text("fetcher_user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  status: text("status").notNull().default("pending"),
  postedDiscordUrl: text("posted_discord_url"),
});
