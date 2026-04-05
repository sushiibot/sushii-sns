import {
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type SendableChannels,
} from "discord.js";
import type { ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import type { MonitorsConfig } from "../config";
import { findConnectionById, getConnectionId } from "../config";
import type { MonitorRepository } from "../data/repository";
import { buildPanelEmbed } from "../view/panel";
import { fetchConnectionAndCreateReviews, syncAllMonitorConnections } from "../service/fetch";
import { sendMonitorLog } from "../log_channel";
import type { ReviewStore } from "../service/review/store";
import type { PostQueue } from "../service/queue";

const log = logger.child({ module: "monitor/handlers/panel" });

export class PanelHandler {
  private panelPollInProgress = false;

  constructor(
    private readonly repo: MonitorRepository,
    private readonly reviewStore: ReviewStore,
    private readonly postQueue: PostQueue,
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

    if (this.panelPollInProgress) {
      await interaction.reply({
        content: "A fetch is already in progress. Please wait until it finishes.",
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

    this.panelPollInProgress = true;
    try {
      await sendMonitorLog(
        this.client,
        this.config,
        `Poll started: \`${connectionId}\` by ${interaction.user.username}`,
      );

      await fetchConnectionAndCreateReviews(
        interaction,
        this.client,
        this.config,
        this.serverConfig,
        this.repo,
        connectionId,
        this.reviewStore,
      );

      await this.refreshPanelEmbed();

      await sendMonitorLog(
        this.client,
        this.config,
        `Poll finished: \`${connectionId}\` by ${interaction.user.username}`,
      );
    } finally {
      this.panelPollInProgress = false;
    }
  }

  async refreshPanelEmbed(): Promise<boolean> {
    const panelMessage = this.repo.getPanelMessage(this.config.panel_channel_id);
    if (!panelMessage) return false;

    const channel = await this.client.channels.fetch(this.config.panel_channel_id);
    if (!channel || !channel.isTextBased()) return false;

    const msg = await channel.messages.fetch(panelMessage.message_id);
    const connectionsMeta = this.buildPanelConnectionsMeta();
    const embedData = buildPanelEmbed(connectionsMeta as any);
    await msg.edit(embedData);
    return true;
  }

  async postAndPinPanelEmbed(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.channel || !("send" in interaction.channel)) {
      throw new Error("Cannot send in this channel.");
    }

    const connectionsMeta = this.buildPanelConnectionsMeta();
    const embedData = buildPanelEmbed(connectionsMeta as any);

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
    }
  }

  async handlePanelSetup(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    if (cmd.channelId !== this.config.panel_channel_id) {
      await cmd.editReply({
        content: "Run this command in the configured panel channel (panel_channel_id).",
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

    const type = cmd.options.getString("type", true);
    const handle = cmd.options.getString("handle", true);
    const connectionId = `${type}:${handle}`;

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

  private buildPanelConnectionsMeta() {
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
}
