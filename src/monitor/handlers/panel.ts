import { RESTJSONErrorCodes } from "discord-api-types/v10";
import {
  DiscordAPIError,
  GuildMember,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type SendableChannels,
} from "discord.js";
import type { ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import type { AnySnsMetadata, PostData, SnsMetadata } from "../../platforms/base";
import { buildInlineFormatContent } from "../../utils/template";
import type { MonitorsConfig } from "../config";
import { findConnectionById, getConnectionId } from "../config";
import type { MonitorRepository } from "../data/repository";
import { buildPanelEmbed, type PanelConnectionMeta } from "../view/panel";
import { batchToMessageOptions, buildReviewBatches } from "../view/review";
import { syncAllMonitorConnections, fetchConnectionPosts, downloadFilesFromUrls } from "../service/fetch";
import { sendMonitorLog } from "../log_channel";
import type { ReviewState } from "../service/review/types";
import type { ReviewStore } from "../service/review/store";

const log = logger.child({ module: "monitor/handlers/panel" });


const NOT_CONFIGURED_MSG =
  "Monitor is not configured for this server. Use `/monitor setup` to get started.";


function getDisplayName(interaction: ButtonInteraction): string {
  const member = interaction.member;
  if (member instanceof GuildMember) return member.displayName;
  return interaction.user.displayName;
}

export class PanelHandler {
  // Per-connection lock set — prevents concurrent fetches for the same connection
  private activeFetches = new Set<string>();

  private readonly MAX_REVIEWS_PER_POLL = 3;
  private readonly MAX_STORIES_PER_POLL = 10;

  constructor(
    private readonly repo: MonitorRepository,
    private readonly reviewStore: ReviewStore,
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
      await interaction.reply({ content: NOT_CONFIGURED_MSG, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.channelId !== config.panel_channel_id) {
      await interaction.reply({
        content: "This button is only valid in the panel channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (this.activeFetches.has(connectionId)) {
      await interaction.reply({
        content: "A fetch for this connection is already in progress.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (config.trigger_role_id) {
      const member = interaction.member;
      if (!member) {
        await interaction.reply({ content: "Could not verify your roles.", flags: MessageFlags.Ephemeral });
        return;
      }

      const hasRole =
        member instanceof GuildMember
          ? member.roles.cache.has(config.trigger_role_id)
          : Array.isArray(member.roles) && member.roles.includes(config.trigger_role_id);
      if (!hasRole) {
        await interaction.reply({
          content: "You don't have the required role to poll.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const connection = findConnectionById(config, connectionId);
    if (!connection) {
      await interaction.reply({ content: "Unknown connection.", flags: MessageFlags.Ephemeral });
      return;
    }

    const lastFetch = this.repo.getConnectionMeta(guildId, connectionId);
    if (lastFetch) {
      const nextPollAt = lastFetch.last_fetched_at + connection.cooldown_seconds * 1000;
      if (Date.now() < nextPollAt) {
        const nextPollSec = Math.floor(nextPollAt / 1000);
        await interaction.reply({
          content: `On cooldown. Next poll available <t:${nextPollSec}:R>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    this.activeFetches.add(connectionId);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      await sendMonitorLog(
        this.client,
        config.log_channel_id,
        `Poll started: \`${connectionId}\` by ${interaction.user.username}`,
      );

      await this.fetchConnectionAndCreateReviews(interaction, guildId, config, connectionId);
      await this.refreshPanelEmbed(guildId, config);

      await sendMonitorLog(
        this.client,
        config.log_channel_id,
        `Poll finished: \`${connectionId}\` by ${interaction.user.username}`,
      );
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
      if (result !== "message_gone") return;
      // Message was deleted — fall through to re-send
    }

    try {
      const channel = await this.client.channels.fetch(config.panel_channel_id);
      if (!channel || !("send" in channel)) {
        log.warn({ guildId, channelId: config.panel_channel_id }, "Panel channel not found or not sendable");
        return;
      }

      const connectionsMeta = this.buildPanelConnectionsMeta(guildId, config);
      const embedData = buildPanelEmbed(connectionsMeta);
      const msg = await (channel as SendableChannels).send(embedData);

      try {
        await msg.pin();
      } catch (err) {
        log.warn(err, "Failed to pin panel embed");
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
      await cmd.editReply({ content: "Must be used in a guild." });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await cmd.editReply({ content: NOT_CONFIGURED_MSG });
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
      await sendMonitorLog(this.client, config.log_channel_id, `/fetch-all completed by ${cmd.user.username}`);
      await cmd.editReply({
        content: "Finished polling all connections (items marked as seen). Monitor panel updated.",
      });
    } catch (err) {
      log.error(err, "/fetch-all failed");
      await cmd.editReply({ content: "Something went wrong while syncing." });
    } finally {
      for (const id of idsToLock) this.activeFetches.delete(id);
    }
  }

  async handlePanelRefresh(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.editReply({ content: "Must be used in a guild." });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await cmd.editReply({ content: NOT_CONFIGURED_MSG });
      return;
    }

    await this.ensurePanelSent(guildId, config);
    await cmd.editReply({ content: "Panel refreshed." });
  }

  private buildPanelConnectionsMeta(guildId: string, config: MonitorsConfig): PanelConnectionMeta[] {
    return config.connections.map((c) => {
      const id = getConnectionId(c);
      return {
        connectionId: id,
        label: `${c.type}/${c.handle}`,
        cooldownSeconds: c.cooldown_seconds,
        lastFetch: this.repo.getConnectionMeta(guildId, id),
      };
    });
  }

  private async fetchConnectionAndCreateReviews(
    interaction: ButtonInteraction,
    guildId: string,
    config: MonitorsConfig,
    connectionId: string,
  ): Promise<void> {
    const connection = findConnectionById(config, connectionId);
    if (!connection) {
      await interaction.editReply({ content: "Unknown connection." });
      return;
    }

    await interaction.editReply("Fetching latest posts...");

    let posts: PostData<AnySnsMetadata>[] = [];
    try {
      posts = await fetchConnectionPosts(connection, downloadFilesFromUrls, {
        isPostSeen: (id) => this.repo.isPostSeen(guildId, connectionId, id),
        markPostSeen: (id) => this.repo.markPostSeen(guildId, connectionId, id),
        limit: this.MAX_REVIEWS_PER_POLL,
        storiesLimit: this.MAX_STORIES_PER_POLL,
      });
    } catch (err) {
      log.error({ err, connectionId }, "Failed to fetch connection posts");
      await interaction.editReply("Failed to fetch posts. Please try again.");
      return;
    }

    if (posts.length === 0) {
      this.repo.upsertConnectionMeta(guildId, connectionId, Date.now(), getDisplayName(interaction));
      await interaction.editReply("No new posts found.");
      return;
    }

    const reviewChannel = interaction.channel;
    if (!reviewChannel || !("send" in reviewChannel)) {
      await interaction.editReply("Cannot send review messages in this channel.");
      return;
    }

    let postsToReview: PostData<AnySnsMetadata>[] = [];
    let stories: PostData<AnySnsMetadata>[] = [];
    let regularPosts: PostData<AnySnsMetadata>[] = [];

    if (connection.type === "instagram") {
      const isInstagramStory = (p: PostData<AnySnsMetadata>): boolean =>
        p.postLink?.metadata?.platform === "instagram-story";

      stories = posts.filter(isInstagramStory);
      regularPosts = posts.filter((p) => !isInstagramStory(p));
      postsToReview = [
        ...stories,
        ...regularPosts.slice(0, this.MAX_REVIEWS_PER_POLL),
      ];
    } else {
      postsToReview = posts.slice(0, this.MAX_REVIEWS_PER_POLL);
    }

    const socialsChannelId = config.socials_channel_id;
    let reviewCount = 0;

    for (const postData of postsToReview) {
      if (!postData.postID) continue;

      const renderedContent = buildInlineFormatContent(config.template, postData as PostData<SnsMetadata>);

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
        fileNames: postData.files.map((f, i) => `media-${i}.${f.ext}`),
        messageIds: [],
      };

      const reviewId = this.reviewStore.create(reviewState);

      try {
        const batches = buildReviewBatches(reviewState, reviewId);
        const messageIds: string[] = [];

        for (const batch of batches) {
          const msg = await (reviewChannel as SendableChannels).send(
            batchToMessageOptions(batch),
          );
          messageIds.push(msg.id);
        }

        this.reviewStore.update(reviewId, { messageIds });
        reviewCount++;
      } catch (err) {
        log.error({ err, reviewId }, "Failed to send review message");
        this.reviewStore.delete(reviewId);
      }
    }

    this.repo.upsertConnectionMeta(guildId, connectionId, Date.now(), getDisplayName(interaction));

    if (connection.type === "instagram") {
      const cappedPosts = regularPosts.slice(0, this.MAX_REVIEWS_PER_POLL);
      await interaction.editReply(
        `Found ${reviewCount} new post${reviewCount === 1 ? "" : "s"} (${stories.length} ${stories.length === 1 ? "story" : "stories"} + ${cappedPosts.length} post${cappedPosts.length === 1 ? "" : "s"}). Review messages created below.`,
      );
    } else {
      await interaction.editReply(
        `Found ${reviewCount} new post${reviewCount === 1 ? "" : "s"}. Review messages created below.`,
      );
    }
  }
}
