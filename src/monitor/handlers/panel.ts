import {
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type SendableChannels,
} from "discord.js";
import type { ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import type { AnySnsMetadata, PostData, SnsMetadata } from "../../platforms/base";
import { buildInlineFormatContent } from "../../utils/template";
import type { MonitorsConfig, ConnectionType } from "../config";
import { ConnectionTypeSchema, findConnectionById, getConnectionId } from "../config";
import type { MonitorRepository } from "../data/repository";
import { buildPanelEmbed, type PanelConnectionMeta } from "../view/panel";
import { batchToMessageOptions, buildReviewBatches } from "../view/review";
import { syncAllMonitorConnections, fetchConnectionPosts, downloadFilesFromUrls } from "../service/fetch";
import { sendMonitorLog } from "../log_channel";
import type { ReviewState } from "../service/review/types";
import type { ReviewStore } from "../service/review/store";

const log = logger.child({ module: "monitor/handlers/panel" });

function getDisplayName(interaction: ButtonInteraction): string {
  const member = interaction.member;
  if (member instanceof GuildMember) return member.displayName;
  return interaction.user.displayName ?? interaction.user.username;
}

export class PanelHandler {
  // Per-connection lock set — prevents concurrent fetches for the same connection
  // if a user clicks a button rapidly, without blocking unrelated connections.
  private activeFetches = new Set<string>();

  private readonly MAX_REVIEWS_PER_POLL = 3;
  private readonly MAX_STORIES_PER_POLL = 10;

  constructor(
    private readonly repo: MonitorRepository,
    private readonly reviewStore: ReviewStore,
    private readonly config: MonitorsConfig,
    private readonly serverConfig: ServerConfig | null,
    private readonly client: Client,
  ) {}

  async handlePollButton(
    interaction: ButtonInteraction,
    connectionId: string,
  ): Promise<void> {
    if (interaction.channelId !== this.config.panel_channel_id) {
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

    if (this.config.trigger_role_id) {
      const member = interaction.member;
      if (!member) {
        await interaction.reply({ content: "Could not verify your roles.", flags: MessageFlags.Ephemeral });
        return;
      }

      const roles = "cache" in member.roles ? member.roles.cache : null;
      if (!roles || !roles.has(this.config.trigger_role_id)) {
        await interaction.reply({
          content: "You don't have the required role to poll.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const connection = findConnectionById(this.config, connectionId);
    if (!connection) {
      await interaction.reply({ content: "Unknown connection.", flags: MessageFlags.Ephemeral });
      return;
    }

    const lastFetch = this.repo.getConnectionMeta(connectionId);
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
      // Defer before any network calls so the interaction token doesn't expire.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      await sendMonitorLog(
        this.client,
        this.config,
        `Poll started: \`${connectionId}\` by ${interaction.user.username}`,
      );

      await this.fetchConnectionAndCreateReviews(interaction, connectionId);

      await this.refreshPanelEmbed();

      await sendMonitorLog(
        this.client,
        this.config,
        `Poll finished: \`${connectionId}\` by ${interaction.user.username}`,
      );
    } finally {
      this.activeFetches.delete(connectionId);
    }
  }

  async refreshPanelEmbed(): Promise<boolean> {
    const panelMessage = this.repo.getPanelMessage(this.config.panel_channel_id);
    if (!panelMessage) return false;

    const channel = await this.client.channels.fetch(this.config.panel_channel_id);
    if (!channel || !channel.isTextBased()) return false;

    try {
      const msg = await channel.messages.fetch(panelMessage.message_id);
      const connectionsMeta = this.buildPanelConnectionsMeta();
      const embedData = buildPanelEmbed(connectionsMeta);
      await msg.edit(embedData);
    } catch (err) {
      // Discord "Unknown Message" (10008) means the panel message was deleted — expected, log at warn.
      // Any other error is unexpected and should surface as an error.
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

  async postAndPinPanelEmbed(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.channel || !("send" in interaction.channel)) {
      throw new Error("Cannot send in this channel.");
    }

    const connectionsMeta = this.buildPanelConnectionsMeta();
    const embedData = buildPanelEmbed(connectionsMeta);

    const msg = await (interaction.channel as SendableChannels).send(embedData);

    try {
      await msg.pin();
    } catch (err) {
      log.warn(err, "Failed to pin panel embed");
    }

    this.repo.upsertPanelMessage(this.config.panel_channel_id, msg.id);
  }

  async handleFetchAll(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    if (!cmd.guildId) {
      await cmd.editReply({ content: "Must be used in a guild." });
      return;
    }

    if (!cmd.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await cmd.editReply({
        content: "You need Manage Server permission to use this command.",
      });
      return;
    }

    // Lock all connections during fetch-all to prevent concurrent per-connection polls.
    // Only acquire locks for IDs not already held by a running per-connection poll so
    // that we don't steal and then release a lock we didn't own.
    const connectionIds = this.config.connections.map(c => getConnectionId(c));
    const idsToLock = connectionIds.filter(id => !this.activeFetches.has(id));
    for (const id of idsToLock) this.activeFetches.add(id);
    try {
      await syncAllMonitorConnections(this.config, this.repo, {
        lastFetchedBy: cmd.user.username,
      });
      await this.refreshPanelEmbed();
      await sendMonitorLog(
        this.client,
        this.config,
        `/fetch-all completed by ${cmd.user.username}`,
      );
      await cmd.editReply({
        content: "Finished polling all connections (items marked as seen). Monitor panel updated.",
      });
    } catch (err) {
      log.error(err, "/fetch-all failed");
      await cmd.editReply({
        content: "Something went wrong while syncing.",
      });
    } finally {
      for (const id of idsToLock) this.activeFetches.delete(id);
    }
  }

  async handlePanelSetup(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    if (cmd.channelId !== this.config.panel_channel_id) {
      await cmd.editReply({
        content: "Run this command in the configured panel channel.",
      });
      return;
    }

    if (await this.refreshPanelEmbed()) {
      await cmd.editReply({ content: "Panel embed refreshed." });
      return;
    }

    try {
      await this.postAndPinPanelEmbed(cmd);
      await cmd.editReply({ content: "Panel embed posted and pinned." });
    } catch {
      await cmd.editReply({ content: "Failed to post panel embed." });
    }
  }

  async handlePanelRefresh(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    if (!(await this.refreshPanelEmbed())) {
      await cmd.editReply({ content: "Panel embed not found. Run panel setup first." });
      return;
    }

    await cmd.editReply({ content: "Panel embed refreshed." });
  }

  async handleDbPurgeConnection(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    const rawType = cmd.options.getString("type", true);
    const parseResult = ConnectionTypeSchema.safeParse(rawType);
    if (!parseResult.success) {
      await cmd.editReply({ content: `Invalid connection type: \`${rawType}\`.` });
      return;
    }
    const type = parseResult.data; // now properly typed as ConnectionType
    const handle = cmd.options.getString("handle", true);
    const connectionId = getConnectionId({ type, handle });

    try {
      this.repo.purgeConnectionSeenPosts(connectionId);
      this.repo.purgeConnectionMeta(connectionId);
    } catch (err) {
      log.error({ err, connectionId }, "Failed to purge connection DB");
      await cmd.editReply({ content: "Failed to purge connection DB." });
      return;
    }

    await sendMonitorLog(
      this.client,
      this.config,
      `DB purged for connection: \`${connectionId}\` by ${cmd.user.username}`,
    );
    await cmd.editReply({ content: `Purged DB for \`${connectionId}\`.` });
  }

  async handleDbPurgeAll(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      this.repo.purgeAllSeenPosts();
      this.repo.purgeAllConnectionMeta();
    } catch (err) {
      log.error({ err }, "Failed to purge all monitor DB state");
      await cmd.editReply({ content: "Failed to purge all monitor DB state." });
      return;
    }

    await sendMonitorLog(
      this.client,
      this.config,
      `DB purged for ALL connections by ${cmd.user.username}`,
    );
    await cmd.editReply({ content: "Purged DB for all connections." });
  }

  private buildPanelConnectionsMeta(): PanelConnectionMeta[] {
    return this.config.connections.map((c) => {
      const id = getConnectionId(c);
      return {
        connectionId: id,
        label: `${c.type}/${c.handle}`,
        cooldownSeconds: c.cooldown_seconds,
        lastFetch: this.repo.getConnectionMeta(id),
      };
    });
  }

  private async fetchConnectionAndCreateReviews(
    interaction: ButtonInteraction,
    connectionId: string,
  ): Promise<void> {
    const connection = findConnectionById(this.config, connectionId);
    if (!connection) {
      await interaction.editReply({ content: "Unknown connection." });
      return;
    }

    await interaction.editReply("Fetching latest posts...");

    let posts: PostData<AnySnsMetadata>[] = [];
    try {
      posts = await fetchConnectionPosts(connection, downloadFilesFromUrls, {
        isPostSeen: (id) => this.repo.isPostSeen(connectionId, id),
        markPostSeen: (id) => this.repo.markPostSeen(connectionId, id),
        limit: this.MAX_REVIEWS_PER_POLL,
        storiesLimit: this.MAX_STORIES_PER_POLL,
      });
    } catch (err) {
      log.error({ err, connectionId }, "Failed to fetch connection posts");
      await interaction.editReply("Failed to fetch posts. Please try again.");
      return;
    }

    if (posts.length === 0) {
      this.repo.upsertConnectionMeta(connectionId, Date.now(), getDisplayName(interaction));
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
      regularPosts = posts.filter(p => !isInstagramStory(p));
      postsToReview = [
        // stories already capped to MAX_STORIES_PER_POLL by fetchConnectionPosts storiesLimit
        ...stories,
        ...regularPosts.slice(0, this.MAX_REVIEWS_PER_POLL),
      ];
    } else {
      postsToReview = posts.slice(0, this.MAX_REVIEWS_PER_POLL);
    }

    const socialsChannelId = this.config.socials_channel_id;
    let reviewCount = 0;

    for (const postData of postsToReview) {
      if (!postData.postID) continue;

      // PostData<AnySnsMetadata> is not directly assignable to PostData<SnsMetadata> due to
      // TypeScript's generic invariance, but buildInlineFormatContent only accesses base
      // SnsMetadata fields (platform, username, postLink.url, originalText, timestamp), so
      // the cast is safe for all concrete metadata types.
      const renderedContent = buildInlineFormatContent(this.config.template, postData as PostData<SnsMetadata>);

      const reviewState: ReviewState = {
        postData,
        connectionId,
        removedIndices: new Set<number>(),
        customContent: null,
        renderedContent,
        socialsChannelId,
        format: this.config.format,
        template: this.config.template,
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

    this.repo.upsertConnectionMeta(connectionId, Date.now(), getDisplayName(interaction));

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
