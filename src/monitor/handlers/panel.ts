import {
  ActionRowBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type SendableChannels,
  type StringSelectMenuInteraction,
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
  "Monitor is not configured for this server. Use `/monitor config setup` to get started.";

export const DB_PURGE_CONNECTION_SELECT_ID = "monitor:db:purge-connection";

function getDisplayName(interaction: ButtonInteraction): string {
  const member = interaction.member;
  if (member instanceof GuildMember) return member.displayName;
  return interaction.user.displayName ?? interaction.user.username;
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

      const roles = "cache" in member.roles ? member.roles.cache : null;
      if (!roles || !roles.has(config.trigger_role_id)) {
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

  async refreshPanelEmbed(guildId: string, config?: MonitorsConfig): Promise<boolean> {
    const cfg = config ?? this.repo.getConfig(guildId);
    if (!cfg?.panel_message_id) return false;

    const channel = await this.client.channels.fetch(cfg.panel_channel_id);
    if (!channel || !channel.isTextBased()) return false;

    try {
      const msg = await channel.messages.fetch(cfg.panel_message_id);
      const connectionsMeta = this.buildPanelConnectionsMeta(guildId, cfg);
      const embedData = buildPanelEmbed(connectionsMeta);
      await msg.edit(embedData);
    } catch (err) {
      const isUnknownMessage =
        (err as any)?.code === 10008 ||
        (err instanceof Error && err.message.includes("Unknown Message"));
      if (isUnknownMessage) {
        log.warn({ err }, "Panel message not found or deleted, skipping embed refresh");
      } else {
        log.error({ err }, "Unexpected error refreshing panel embed");
      }
      return false;
    }
    return true;
  }

  async postAndPinPanelEmbed(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    config: MonitorsConfig,
  ): Promise<void> {
    if (!interaction.channel || !("send" in interaction.channel)) {
      throw new Error("Cannot send in this channel.");
    }

    const connectionsMeta = this.buildPanelConnectionsMeta(guildId, config);
    const embedData = buildPanelEmbed(connectionsMeta);

    const msg = await (interaction.channel as SendableChannels).send(embedData);

    try {
      await msg.pin();
    } catch (err) {
      log.warn(err, "Failed to pin panel embed");
    }

    this.repo.updatePanelMessage(guildId, msg.id);
  }

  async handleFetchAll(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.editReply({ content: "Must be used in a guild." });
      return;
    }

    if (!cmd.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await cmd.editReply({ content: "You need Manage Server permission to use this command." });
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
    try {
      await syncAllMonitorConnections(guildId, config.connections, this.repo, {
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

  async handlePanelSetup(cmd: ChatInputCommandInteraction): Promise<void> {
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

    if (cmd.channelId !== config.panel_channel_id) {
      await cmd.editReply({ content: "Run this command in the configured panel channel." });
      return;
    }

    if (await this.refreshPanelEmbed(guildId, config)) {
      await cmd.editReply({ content: "Panel embed refreshed." });
      return;
    }

    try {
      await this.postAndPinPanelEmbed(cmd, guildId, config);
      await cmd.editReply({ content: "Panel embed posted and pinned." });
    } catch {
      await cmd.editReply({ content: "Failed to post panel embed." });
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

    if (!(await this.refreshPanelEmbed(guildId, config))) {
      await cmd.editReply({ content: "Panel embed not found. Run panel setup first." });
      return;
    }

    await cmd.editReply({ content: "Panel embed refreshed." });
  }

  async handleDbPurgeConnection(cmd: ChatInputCommandInteraction): Promise<void> {
    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config || config.connections.length === 0) {
      await cmd.reply({ content: NOT_CONFIGURED_MSG, flags: MessageFlags.Ephemeral });
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(DB_PURGE_CONNECTION_SELECT_ID)
      .setPlaceholder("Select a connection to purge")
      .addOptions(
        config.connections.map((c) => {
          const id = getConnectionId(c);
          return new StringSelectMenuOptionBuilder().setLabel(id).setValue(id);
        }),
      );

    await cmd.reply({
      content: "Select a connection to purge (resets cooldown and seen-post history):",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
  }

  async handleDbPurgeConnectionSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await interaction.update({ content: NOT_CONFIGURED_MSG, components: [] });
      return;
    }

    const connectionId = interaction.values[0];
    if (!connectionId) {
      await interaction.reply({ content: "No connection selected.", flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      this.repo.purgeConnectionSeenPosts(guildId, connectionId);
      this.repo.purgeConnectionMeta(guildId, connectionId);
    } catch (err) {
      log.error({ err, connectionId }, "Failed to purge connection DB");
      await interaction.update({ content: "Failed to purge connection DB.", components: [] });
      return;
    }

    await sendMonitorLog(
      this.client,
      config.log_channel_id,
      `DB purged for connection: \`${connectionId}\` by ${interaction.user.username}`,
    );
    await interaction.update({ content: `✅ Purged DB for \`${connectionId}\`.`, components: [] });
  }

  async handleDbPurgeAll(cmd: ChatInputCommandInteraction): Promise<void> {
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

    try {
      this.repo.purgeAllSeenPosts(guildId);
      this.repo.purgeAllConnectionMeta(guildId);
    } catch (err) {
      log.error({ err }, "Failed to purge all monitor DB state");
      await cmd.editReply({ content: "Failed to purge all monitor DB state." });
      return;
    }

    await sendMonitorLog(
      this.client,
      config.log_channel_id,
      `DB purged for ALL connections by ${cmd.user.username}`,
    );
    await cmd.editReply({ content: "Purged DB for all connections." });
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
