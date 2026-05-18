import { randomUUID } from "crypto";
import { RESTJSONErrorCodes } from "discord-api-types/v10";
import {
  DiscordAPIError,
  GuildMember,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import type { AnySnsMetadata, PostData, SnsMetadata } from "../../platforms/base";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { buildInlineFormatContent } from "../../utils/template";
import { KST_TIMEZONE } from "../../utils/discord";

dayjs.extend(utc);
dayjs.extend(timezone);
import type { Connection, MonitorsConfig } from "../config";
import { findConnectionById, getConnectionId } from "../config";
import type { MonitorRepository } from "../data/repository";
import { buildPanelEmbed, type PanelConnectionMeta } from "../view/panel";
import { batchToMessageOptions, buildReviewBatches } from "../view/review";
import { syncAllMonitorConnections, fetchConnectionPosts, downloadFilesFromUrls } from "../service/fetch";
import { seedConnection, type SeedResult } from "../service/seed";
import type { ReviewState } from "../service/review/types";
import { ephemeralError, ephemeralWarn, editError, editSuccess, editInfo } from "../view/ephemeral";

const log = logger.child({ module: "monitor/handlers/panel" });


/**
 * Group Instagram stories by KST calendar day, merging each day's stories into a
 * single synthetic PostData whose `files` array contains all media for that day.
 * Stories without a timestamp are each kept as individual reviews.
 */
function groupStoriesByKstDay(
  stories: PostData<AnySnsMetadata>[],
): PostData<AnySnsMetadata>[] {
  const byDay = new Map<string, PostData<AnySnsMetadata>[]>();
  for (const story of stories) {
    const key = story.timestamp
      ? dayjs(story.timestamp).tz(KST_TIMEZONE).format("YYYY-MM-DD")
      : `untimed-${story.postID}`;
    const bucket = byDay.get(key) ?? [];
    bucket.push(story);
    byDay.set(key, bucket);
  }

  return Array.from(byDay.values()).map((dayStories) => {
    if (dayStories.length === 1) { return dayStories[0]; }
    const first = dayStories[0];
    return {
      ...first,
      postID: dayStories.map((s) => s.postID).filter(Boolean).join("+"),
      files: dayStories.flatMap((s) => s.files),
    };
  });
}

function getDisplayName(interaction: ButtonInteraction): string {
  const member = interaction.member;
  if (member instanceof GuildMember) return member.displayName;
  return interaction.user.displayName;
}

export class PanelHandler {
  // Per-connection lock set — prevents concurrent fetches for the same connection
  private activeFetches = new Set<string>();

  private static readonly NOT_CONFIGURED_MSG =
    "Monitor is not configured for this server. Use `/monitor setup` to get started.";

  private static readonly MAX_REVIEWS_PER_POLL = 3;
  private static readonly MAX_STORIES_PER_POLL = 10;
  private static readonly POLL_COOLDOWN_MS = 30_000;

  constructor(
    private readonly repo: MonitorRepository,
    private readonly serverConfig: ServerConfig | null,
    private readonly client: Client,
  ) {}

  async handlePollButton(
    interaction: ButtonInteraction,
    connectionId: string,
  ): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) return;

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await interaction.reply(ephemeralError(PanelHandler.NOT_CONFIGURED_MSG));
      return;
    }

    if (interaction.channelId !== config.panel_channel_id) {
      await interaction.reply(ephemeralError("This button is only valid in the panel channel."));
      return;
    }

    if (this.activeFetches.has(connectionId)) {
      await interaction.reply(ephemeralWarn("A fetch for this connection is already in progress."));
      return;
    }

    if (config.trigger_role_id) {
      const member = interaction.member;
      if (!member) {
        await interaction.reply(ephemeralError("Could not verify your roles."));
        return;
      }

      const hasRole =
        member instanceof GuildMember
          ? member.roles.cache.has(config.trigger_role_id)
          : Array.isArray(member.roles) && member.roles.includes(config.trigger_role_id);
      if (!hasRole) {
        await interaction.reply(ephemeralError("You don't have the required role to do this."));
        return;
      }
    }

    const connection = findConnectionById(config, connectionId);
    if (!connection) {
      await interaction.reply(ephemeralError("Unknown connection."));
      return;
    }

    const lastFetch = this.repo.getConnectionMeta(guildId, connectionId);
    if (lastFetch) {
      const nextPollAt = lastFetch.last_fetched_at + PanelHandler.POLL_COOLDOWN_MS;
      if (Date.now() < nextPollAt) {
        const nextPollSec = Math.floor(nextPollAt / 1000);
        await interaction.reply(ephemeralWarn(`On cooldown — you can refresh again <t:${nextPollSec}:R>.`));
        return;
      }
    }

    this.activeFetches.add(connectionId);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const fetcherUsername = getDisplayName(interaction);
      await this.fetchConnectionAndCreateReviews(interaction, guildId, config, connectionId, fetcherUsername);
      await this.refreshPanelEmbed(guildId, config);
    } finally {
      this.activeFetches.delete(connectionId);
    }
  }

  /** Returns "refreshed" | "message_gone" | "error" */
  async refreshPanelEmbed(guildId: string, config?: MonitorsConfig): Promise<"refreshed" | "message_gone" | "error"> {
    const cfg = config ?? this.repo.getConfig(guildId);
    if (!cfg?.panel_message_id) return "message_gone";

    const channel = await this.client.channels.fetch(cfg.panel_channel_id);
    if (!channel || !channel.isTextBased()) return "error";

    try {
      const msg = await channel.messages.fetch(cfg.panel_message_id);
      const connectionsMeta = this.buildPanelConnectionsMeta(guildId, cfg);
      const embedData = buildPanelEmbed(connectionsMeta);
      await msg.edit(embedData);
    } catch (err) {
      const isUnknownMessage =
        err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage;
      if (isUnknownMessage) {
        log.warn({ err }, "Panel message not found or deleted, skipping embed refresh");
        return "message_gone";
      }
      log.error({ err }, "Unexpected error refreshing panel embed");
      return "error";
    }
    return "refreshed";
  }

  /**
   * Post+pin the panel to the configured panel channel and save the message ID.
   * Fetches the channel from the client — does not require a command interaction.
   */
  async ensurePanelSent(guildId: string, config: MonitorsConfig): Promise<void> {
    if (config.panel_message_id) {
      const result = await this.refreshPanelEmbed(guildId, config);
      if (result === "refreshed") return;
      // message_gone or error (e.g. transitioning from legacy embed) — fall through to re-send
    }

    try {
      const channel = await this.client.channels.fetch(config.panel_channel_id);
      if (!channel || !channel.isSendable()) {
        log.warn({ guildId, channelId: config.panel_channel_id }, "Panel channel not found or not sendable");
        return;
      }

      const connectionsMeta = this.buildPanelConnectionsMeta(guildId, config);
      const embedData = buildPanelEmbed(connectionsMeta);
      const msg = await channel.send(embedData);

      try {
        await msg.pin();
      } catch (err) {
        log.warn(err, "Failed to pin panel embed");
        try {
          await channel.send(`⚠️ Failed to auto-pin the panel message — please pin it manually: ${msg.url}`);
        } catch (sendErr) {
          log.warn(sendErr, "Failed to send pin-failure notice");
        }
      }

      this.repo.updatePanelMessage(guildId, msg.id);
    } catch (err) {
      log.error({ err, guildId }, "Failed to send panel embed");
    }
  }


  async handleFetchAll(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.editReply(editError("Must be used in a guild."));
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await cmd.editReply(editError(PanelHandler.NOT_CONFIGURED_MSG));
      return;
    }

    const connectionIds = config.connections.map((c) => getConnectionId(c));
    const idsToLock = connectionIds.filter((id) => !this.activeFetches.has(id));
    for (const id of idsToLock) this.activeFetches.add(id);
    const lockedConnections = config.connections.filter(
      (c) => idsToLock.includes(getConnectionId(c))
    );
    try {
      await syncAllMonitorConnections(guildId, lockedConnections, this.repo, {
        lastFetchedBy: cmd.user.username,
      });
      await this.refreshPanelEmbed(guildId, config);
      await cmd.editReply(editSuccess("Finished refreshing all connections (items marked as seen). Monitor panel updated."));
    } catch (err) {
      log.error(err, "/fetch-all failed");
      await cmd.editReply(editError("Something went wrong while syncing."));
    } finally {
      for (const id of idsToLock) this.activeFetches.delete(id);
    }
  }

  async handlePanelRefresh(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.editReply(editError("Must be used in a guild."));
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await cmd.editReply(editError(PanelHandler.NOT_CONFIGURED_MSG));
      return;
    }

    await this.ensurePanelSent(guildId, config);

    const updatedConfig = this.repo.getConfig(guildId);
    const panelLink =
      updatedConfig?.panel_message_id
        ? ` https://discord.com/channels/${guildId}/${updatedConfig.panel_channel_id}/${updatedConfig.panel_message_id}`
        : "";
    await cmd.editReply(editSuccess(`Panel refreshed.${panelLink}`));
  }

  /**
   * Fetches the current feed for a newly-added connection, marks all items as seen,
   * and returns the count + profile display name.
   *
   * Throws if the platform API call fails (invalid account, network error, etc.).
   * Callers are responsible for catching and rolling back addMonitor if needed.
   */
  async seedNewConnection(
    guildId: string,
    connection: Connection,
    username: string,
  ): Promise<SeedResult> {
    const connectionId = getConnectionId(connection);
    const result = await seedConnection(
      connection,
      (id) => this.repo.isPostSeen(guildId, connectionId, id),
      (id) => this.repo.markPostSeen(guildId, connectionId, id),
    );
    this.repo.upsertConnectionMeta(guildId, connectionId, Date.now(), username);
    return result;
  }

  private buildPanelConnectionsMeta(guildId: string, config: MonitorsConfig): PanelConnectionMeta[] {
    return config.connections.map((c) => {
      const id = getConnectionId(c);
      return {
        connectionId: id,
        label: `${c.type}/${c.handle}`,
        lastFetch: this.repo.getConnectionMeta(guildId, id),
      };
    });
  }

  private async fetchConnectionAndCreateReviews(
    interaction: ButtonInteraction,
    guildId: string,
    config: MonitorsConfig,
    connectionId: string,
    fetcherUsername: string,
  ): Promise<void> {
    const connection = findConnectionById(config, connectionId);
    if (!connection) {
      await interaction.editReply(editError("Unknown connection."));
      return;
    }

    await interaction.editReply(editInfo("Fetching latest posts..."));

    let posts: PostData<AnySnsMetadata>[] = [];
    try {
      posts = await fetchConnectionPosts(connection, downloadFilesFromUrls, {
        isPostSeen: (id) => this.repo.isPostSeen(guildId, connectionId, id),
        markPostSeen: (id) => this.repo.markPostSeen(guildId, connectionId, id),
        limit: PanelHandler.MAX_REVIEWS_PER_POLL,
        storiesLimit: PanelHandler.MAX_STORIES_PER_POLL,
      });
    } catch (err) {
      log.error({ err, connectionId }, "Failed to fetch connection posts");
      await interaction.editReply(editError("Failed to fetch posts. Please try again."));
      return;
    }

    if (posts.length === 0) {
      this.repo.upsertConnectionMeta(guildId, connectionId, Date.now(), fetcherUsername);
      await interaction.editReply(editInfo(
        "No new posts found.\n\n" +
        "**Tip:** Only click Refresh once you've already gotten a notification in the app — that way you know there's actually something new to fetch.",
      ));
      return;
    }

    const reviewChannel = interaction.channel;
    if (!reviewChannel || !reviewChannel.isSendable()) {
      await interaction.editReply(editError("Cannot send review messages in this channel."));
      return;
    }

    let postsToReview: PostData<AnySnsMetadata>[];
    let regularPosts: PostData<AnySnsMetadata>[] = [];
    let storiesCount = 0;
    let storyGroupCount = 0;

    if (connection.type === "instagram") {
      const isInstagramStory = (p: PostData<AnySnsMetadata>): boolean =>
        p.postLink?.metadata?.platform === "instagram-story";

      const stories = posts.filter(isInstagramStory);
      storiesCount = stories.length;
      const storyGroups = groupStoriesByKstDay(stories);
      storyGroupCount = storyGroups.length;
      regularPosts = posts.filter((p) => !isInstagramStory(p));
      postsToReview = [
        ...storyGroups,
        ...regularPosts.slice(0, PanelHandler.MAX_REVIEWS_PER_POLL),
      ];
    } else {
      postsToReview = posts.slice(0, PanelHandler.MAX_REVIEWS_PER_POLL);
    }

    const socialsChannelId = connection.target_channel_id ?? config.socials_channel_id;
    let reviewCount = 0;

    for (const postData of postsToReview) {
      if (!postData.postID) continue;

      const renderedContent = buildInlineFormatContent(config.template, postData as PostData<SnsMetadata>);
      const reviewId = randomUUID();
      const fileNames = postData.files.map((f, i) => `media-${i}.${f.ext}`);

      this.repo.insertPendingReview({
        reviewId,
        guildId,
        connectionId,
        postId: postData.postID ?? "",
        postUrl: postData.postLink.url,
        platform: postData.postLink.metadata.platform,
        username: postData.username,
        originalText: postData.originalText ?? "",
        fileNames,
        renderedContent,
        socialsChannelId,
        format: config.format,
        template: config.template,
        fetcherUserId: interaction.user.id,
      });

      const reviewState: ReviewState = {
        postData,
        guildId,
        connectionId,
        removedIndices: new Set<number>(),
        customContent: null,
        renderedContent,
        socialsChannelId,
        format: config.format,
        template: config.template,
        fetcherUserId: interaction.user.id,
        fetcherUsername,
        fileNames,
        messageIds: [],
      };

      try {
        const batches = buildReviewBatches(reviewState, reviewId);
        const messageIds: string[] = [];

        for (const batch of batches) {
          const msg = await reviewChannel.send(
            batchToMessageOptions(batch),
          );
          messageIds.push(msg.id);
        }

        this.repo.updatePendingReview(reviewId, { messageIds });

        // Free buffers now that images are uploaded to Discord.
        // buildReviewBatches still uses postData.files.length for chunking — empty
        // buffers are fine there since edits never re-upload attachments.
        for (const file of postData.files) {
          file.buffer = Buffer.alloc(0);
        }
        reviewCount++;
      } catch (err) {
        log.error({ err, reviewId }, "Failed to send review message");
        this.repo.deletePendingReview(reviewId);
      }
    }

    this.repo.upsertConnectionMeta(guildId, connectionId, Date.now(), fetcherUsername);

    if (connection.type === "instagram") {
      const regularCount = Math.min(regularPosts.length, PanelHandler.MAX_REVIEWS_PER_POLL);
      const storyPart = storiesCount > 0
        ? `${storiesCount} ${storiesCount === 1 ? "story" : "stories"} (${storyGroupCount} ${storyGroupCount === 1 ? "day" : "days"})`
        : null;
      const postPart = regularCount > 0
        ? `${regularCount} post${regularCount === 1 ? "" : "s"}`
        : null;
      const summary = [storyPart, postPart].filter(Boolean).join(" + ") || "0 posts";
      await interaction.editReply(
        editSuccess(`Found ${summary}. Review messages created below.`),
      );
    } else {
      await interaction.editReply(
        editSuccess(`Found ${reviewCount} new post${reviewCount === 1 ? "" : "s"}. Review messages created below.`),
      );
    }
  }
}
