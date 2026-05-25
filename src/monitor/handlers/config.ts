import {
  MessageFlags,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
} from "discord.js";
import { editError, ephemeralError } from "../view/ephemeral";
import logger from "../../logger";
import type { Connection, ConnectionType } from "../config";
import { ConnectionTypeSchema, getConnectionId } from "../config";
import type { MonitorRepository } from "../data/repository";
import type { GuildChannelSettings } from "../data/queries";
import {
  buildConnectionAddModal,
  buildConnectionsPage,
  buildSettingsPage,
  buildTemplateModal,
  lastPageIndex,
  pageToUpdateOptions,
  SETUP_ADD_CONNECTION_BTN,
  SETUP_CONNECTION_ADD_MODAL,
  SETUP_CONNECTION_CHANNEL_PFX,
  SETUP_NAV_CONNECTIONS,
  SETUP_NAV_PAGE_NEXT,
  SETUP_NAV_PAGE_PREV,
  SETUP_NAV_SETTINGS,
  SETUP_PANEL_CHANNEL_SELECT,
  SETUP_REMOVE_CONNECTION_PFX,
  SETUP_SOCIALS_CHANNEL_SELECT,
  SETUP_TEMPLATE_BTN,
  SETUP_TEMPLATE_MODAL,
  SETUP_TRIGGER_ROLE_SELECT,
} from "../view/setup";
import type { PanelHandler } from "./panel";

const log = logger.child({ module: "monitor/handlers/config" });

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

function parseProfileUrl(url: string): { type: ConnectionType; handle: string } | null {
  const ig = url.match(/instagram\.com\/([A-Za-z0-9_.]+)/);
  if (ig && !["p", "reel", "reels", "stories", "explore"].includes(ig[1])) {
    return { type: "instagram", handle: ig[1].replace(/[\/.]+$/, "") };
  }

  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9_.]+)/);
  if (tt) return { type: "tiktok", handle: tt[1].replace(/[\/.]+$/, "") };

  const tw = url.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]+)/);
  if (tw && !["i", "home", "explore", "notifications", "messages"].includes(tw[1])) {
    return { type: "twitter", handle: tw[1] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// ConfigHandler
// ---------------------------------------------------------------------------

export class ConfigHandler {
  /**
   * Pending (pre-save) channel/role picks for guilds that haven't provided
   * both required fields yet (first-time setup).
   * Keyed by setup message ID so concurrent `/monitor setup` invocations in
   * the same guild don't clobber each other's state.
   */
  private pendingSettings = new Map<string, Partial<GuildChannelSettings>>();
  private currentPage = new Map<string, number>();

  private static readonly COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(
    private readonly repo: MonitorRepository,
    private readonly panelHandler: PanelHandler,
  ) {}

  /** Extract GuildChannelSettings fields from a MonitorsConfig, with optional overrides. */
  private settingsFrom(config: GuildChannelSettings, overrides?: Partial<GuildChannelSettings>): GuildChannelSettings {
    const { panel_channel_id, socials_channel_id, trigger_role_id } = config;
    return { panel_channel_id, socials_channel_id, trigger_role_id, ...overrides };
  }

  // ---------------------------------------------------------------------------
  // Slash command entry point
  // ---------------------------------------------------------------------------

  async handleSetupCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    if (!cmd.guildId) {
      await cmd.reply({ ...ephemeralError("Must be used in a guild.") });
      return;
    }

    const guildId = cmd.guildId;
    const config = this.repo.getConfig(guildId);

    const msg = await cmd.reply({
      ...buildSettingsPage(config, null),
      fetchReply: true,
    });

    this.attachCollector(msg, guildId, cmd.user.id, msg.id);
  }

  private attachCollector(msg: Message, guildId: string, ownerId: string, messageId: string): void {
    let currentTab: "settings" | "connections" = "settings";

    const collector = msg.createMessageComponentCollector({
      time: ConfigHandler.COLLECTOR_TIMEOUT_MS,
    });

    collector.on("collect", async (interaction) => {
      if (interaction.user.id !== ownerId) {
        await interaction.reply({ ...ephemeralError("Only the person who opened this panel can use it.") });
        return;
      }

      // Track tab navigation
      if (interaction.isButton()) {
        if (interaction.customId === SETUP_NAV_CONNECTIONS) { currentTab = "connections"; }
        else if (interaction.customId === SETUP_NAV_SETTINGS) { currentTab = "settings"; }
      }

      try {
        if (interaction.isButton()) {
          await this.handleButton(interaction, guildId, messageId);
        } else if (interaction.isChannelSelectMenu()) {
          await this.handleChannelSelect(interaction, guildId, messageId);
        } else if (interaction.isRoleSelectMenu()) {
          await this.handleRoleSelect(interaction, guildId, messageId);
        }
      } catch (err) {
        log.error({ err, guildId }, "Error in setup panel collector");
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ ...ephemeralError("Something went wrong. Please try again.") });
          }
        } catch { /* ignore */ }
      }
    });

    collector.once("end", async (_collected, reason) => {
      this.pendingSettings.delete(messageId);
      const storedPage = this.currentPage.get(messageId) ?? 0;
      this.currentPage.delete(messageId);
      if (reason !== "time") return;
      try {
        const finalConfig = this.repo.getConfig(guildId);
        const expiredOpts = { disabled: true, expired: true };
        const safePage = finalConfig ? Math.min(storedPage, lastPageIndex(finalConfig.connections.length)) : 0;
        const page =
          currentTab === "connections" && finalConfig
            ? buildConnectionsPage(finalConfig, expiredOpts, safePage)
            : buildSettingsPage(finalConfig, null, expiredOpts);
        await msg.edit(page);
      } catch { /* message may have been deleted */ }
    });
  }

  // ---------------------------------------------------------------------------
  // Navigation helper
  // ---------------------------------------------------------------------------

  private async navigatePage(
    interaction: ButtonInteraction,
    guildId: string,
    messageId: string,
    computePage: (current: number, maxPage: number) => number,
  ): Promise<void> {
    const config = this.repo.getConfig(guildId);
    if (!config) {
      await interaction.reply({ ...ephemeralError("Config not found.") });
      return;
    }
    const max = lastPageIndex(config.connections.length);
    const current = this.currentPage.get(messageId) ?? 0;
    const next = computePage(current, max);
    this.currentPage.set(messageId, next);
    await interaction.update(pageToUpdateOptions(buildConnectionsPage(config, {}, next)));
  }

  // ---------------------------------------------------------------------------
  // Button handler (collector)
  // ---------------------------------------------------------------------------

  private async handleButton(
    interaction: ButtonInteraction,
    guildId: string,
    messageId: string,
  ): Promise<void> {
    const { customId } = interaction;

    if (customId === SETUP_NAV_CONNECTIONS) {
      await this.navigatePage(interaction, guildId, messageId, (current, max) => Math.min(current, max));
      return;
    }

    if (customId === SETUP_NAV_PAGE_PREV) {
      await this.navigatePage(interaction, guildId, messageId, (current) => Math.max(0, current - 1));
      return;
    }

    if (customId === SETUP_NAV_PAGE_NEXT) {
      await this.navigatePage(interaction, guildId, messageId, (current, max) => Math.min(max, current + 1));
      return;
    }

    if (customId === SETUP_NAV_SETTINGS) {
      const config = this.repo.getConfig(guildId);
      const pending = this.pendingSettings.get(messageId) ?? null;
      await interaction.update(pageToUpdateOptions(buildSettingsPage(config, pending)));
      return;
    }

    if (customId === SETUP_TEMPLATE_BTN) {
      const config = this.repo.getConfig(guildId);
      if (!config) {
        await interaction.reply({ ...ephemeralError("Save settings first.") });
        return;
      }
      await interaction.showModal(buildTemplateModal(config, interaction.id));
      return;
    }

    if (customId === SETUP_ADD_CONNECTION_BTN) {
      await interaction.showModal(buildConnectionAddModal(interaction.id));
      return;
    }

    if (customId.startsWith(SETUP_REMOVE_CONNECTION_PFX)) {
      await this.handleConnectionRemove(interaction, guildId, customId.slice(SETUP_REMOVE_CONNECTION_PFX.length));
      return;
    }

    // Fallback — acknowledge to avoid "interaction failed" for unknown customIds
    await interaction.deferUpdate();
  }

  private async handleConnectionRemove(
    interaction: ButtonInteraction,
    guildId: string,
    connectionId: string,
  ): Promise<void> {
    const colonIdx = connectionId.indexOf(":");
    if (colonIdx === -1) {
      await interaction.reply({ ...ephemeralError("Invalid connection ID.") });
      return;
    }
    const rawType = connectionId.slice(0, colonIdx);
    const handle = connectionId.slice(colonIdx + 1);
    const typeParsed = ConnectionTypeSchema.safeParse(rawType);
    if (!typeParsed.success) {
      await interaction.reply({ ...ephemeralError("Invalid connection type.") });
      return;
    }
    const type: ConnectionType = typeParsed.data;

    try {
      this.repo.removeMonitor(guildId, type, handle);
    } catch (err) {
      log.error({ err, guildId, connectionId }, "Failed to remove monitor connection");
      await interaction.reply({ ...ephemeralError("Failed to remove connection.") });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await interaction.reply({ ...ephemeralError("Config not found.") });
      return;
    }

    await this.panelHandler.refreshPanelEmbed(guildId, config);

    await this.navigatePage(interaction, guildId, interaction.message.id, (current, max) => Math.min(current, max));
  }

  // ---------------------------------------------------------------------------
  // Channel select handler (collector)
  // ---------------------------------------------------------------------------

  private async handleChannelSelect(
    interaction: ChannelSelectMenuInteraction,
    guildId: string,
    messageId: string,
  ): Promise<void> {
    const { customId } = interaction;

    if (customId.startsWith(SETUP_CONNECTION_CHANNEL_PFX)) {
      const connId = customId.slice(SETUP_CONNECTION_CHANNEL_PFX.length);
      const channelId = interaction.values[0] ?? null;
      this.repo.setConnectionChannel(guildId, connId, channelId);
      const config = this.repo.getConfig(guildId);
      if (!config) {
        await interaction.deferUpdate();
        return;
      }
      const page = this.currentPage.get(messageId) ?? 0;
      await interaction.update(pageToUpdateOptions(buildConnectionsPage(config, {}, page)));
      return;
    }

    let field: keyof GuildChannelSettings | null = null;
    if (customId === SETUP_PANEL_CHANNEL_SELECT) field = "panel_channel_id";
    else if (customId === SETUP_SOCIALS_CHANNEL_SELECT) field = "socials_channel_id";

    if (!field) {
      await interaction.deferUpdate();
      return;
    }

    // Optional selects (min 0) may return empty values to clear
    const newChannelId = interaction.values[0] ?? null;

    // panel_channel_id and socials_channel_id are NOT NULL in the DB schema
    if ((field === "panel_channel_id" || field === "socials_channel_id") && newChannelId === null) {
      await interaction.deferUpdate();
      return;
    }

    const currentConfig = this.repo.getConfig(guildId);

    if (currentConfig) {
      const prevPanelChannel = currentConfig.panel_channel_id;
      this.repo.upsertSettings(guildId, this.settingsFrom(currentConfig, { [field]: newChannelId }));

      // If panel channel changed, send panel to new channel
      if (field === "panel_channel_id" && newChannelId && newChannelId !== prevPanelChannel) {
        const updatedConfig = this.repo.getConfig(guildId);
        if (updatedConfig) {
          await this.panelHandler.ensurePanelSent(guildId, updatedConfig);
        }
      }
    } else {
      // First-time setup: buffer until both required fields are present
      const newPending: Partial<GuildChannelSettings> = {
        ...(this.pendingSettings.get(messageId) ?? {}),
        [field]: newChannelId,
      };
      this.pendingSettings.set(messageId, newPending);

      if (newPending.panel_channel_id && newPending.socials_channel_id) {
        const settings: GuildChannelSettings = {
          panel_channel_id: newPending.panel_channel_id,
          socials_channel_id: newPending.socials_channel_id,
          trigger_role_id: newPending.trigger_role_id ?? null,
        };
        this.repo.upsertSettings(guildId, settings);
        this.pendingSettings.delete(messageId);

        const savedConfig = this.repo.getConfig(guildId);
        if (savedConfig) {
          await this.panelHandler.ensurePanelSent(guildId, savedConfig);
        }
      }
    }

    const freshConfig = this.repo.getConfig(guildId);
    const freshPending = this.pendingSettings.get(messageId) ?? null;
    await interaction.update(pageToUpdateOptions(buildSettingsPage(freshConfig, freshPending)));
  }

  // ---------------------------------------------------------------------------
  // Role select handler (collector)
  // ---------------------------------------------------------------------------

  private async handleRoleSelect(
    interaction: RoleSelectMenuInteraction,
    guildId: string,
    messageId: string,
  ): Promise<void> {
    const newRoleId = interaction.values[0] ?? null;
    const currentConfig = this.repo.getConfig(guildId);

    if (currentConfig) {
      this.repo.upsertSettings(guildId, this.settingsFrom(currentConfig, { trigger_role_id: newRoleId }));
    } else {
      const newPending: Partial<GuildChannelSettings> = {
        ...(this.pendingSettings.get(messageId) ?? {}),
        trigger_role_id: newRoleId,
      };
      this.pendingSettings.set(messageId, newPending);
    }

    const freshConfig = this.repo.getConfig(guildId);
    const freshPending = this.pendingSettings.get(messageId) ?? null;
    await interaction.update(pageToUpdateOptions(buildSettingsPage(freshConfig, freshPending)));
  }

  // ---------------------------------------------------------------------------
  // Modal submit handlers (called from global dispatcher)
  // ---------------------------------------------------------------------------

  async handleTemplateModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) return;

    const [rawFormat] = interaction.fields.getStringSelectValues("format");
    if (rawFormat !== "inline" && rawFormat !== "links") {
      await interaction.reply({ ...ephemeralError(`Invalid format \`${rawFormat}\`. Must be \`inline\` or \`links\`.`) });
      return;
    }

    const template = interaction.fields.getTextInputValue("template").trim();

    try {
      this.repo.updateTemplate(guildId, rawFormat, template);
    } catch (err) {
      log.error({ err, guildId }, "Failed to save template");
      await interaction.reply({ ...ephemeralError("Failed to save template.") });
      return;
    }

    const config = this.repo.getConfig(guildId);

    if (interaction.isFromMessage() && config) {
      await interaction.update(pageToUpdateOptions(buildSettingsPage(config, null)));
    } else {
      await interaction.reply({
        content: `✅ Template saved. Format: \`${rawFormat}\``,
        flags: MessageFlags.Ephemeral,
      }); // rare fallback path — not a V2 message
    }
  }

  async handleConnectionAddModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) return;

    const url = interaction.fields.getTextInputValue("url").trim();
    const parsed = parseProfileUrl(url);

    if (!parsed) {
      await interaction.reply({
        ...ephemeralError(
          `Could not detect platform from that URL.\nSupported: \`instagram.com\`, \`tiktok.com\`, \`twitter.com\`, \`x.com\``,
        ),
      });
      return;
    }

    // Defer early — initial seed fetch can take a few seconds
    const fromMessage = interaction.isFromMessage();
    if (fromMessage) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const newConnection: Connection = {
      type: parsed.type,
      handle: parsed.handle,
    };

    // Save first (posts table FK requires monitors row to exist)
    try {
      this.repo.addMonitor(guildId, newConnection);
    } catch (err) {
      log.error({ err, guildId, ...parsed }, "Failed to add monitor connection");
      if (fromMessage) {
        await interaction.followUp({ ...ephemeralError("Failed to add connection.") });
      } else {
        await interaction.editReply(editError("Failed to add connection."));
      }
      return;
    }

    // Seed: validate the account exists and mark existing posts as seen.
    // If the API call fails (bad handle, private account, etc.), roll back.
    let seed: { count: number; profileName: string | null };
    try {
      seed = await this.panelHandler.seedNewConnection(guildId, newConnection, interaction.user.id, interaction.user.globalName);
    } catch (err) {
      log.warn({ err, guildId, ...parsed }, "Seed failed for new connection — rolling back");
      try { this.repo.removeMonitor(guildId, parsed.type, parsed.handle); } catch { /* ignore */ }
      const msg = "Could not fetch posts for that account. Check the URL and try again.";
      if (fromMessage) {
        await interaction.followUp({ ...ephemeralError(msg) });
      } else {
        await interaction.editReply(editError(msg));
      }
      return;
    }

    // Persist profile name if the platform returned one
    if (seed.profileName) {
      this.repo.setProfileName(guildId, getConnectionId(newConnection), seed.profileName);
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      if (fromMessage) {
        await interaction.followUp({ ...ephemeralError("Config not found.") });
      } else {
        await interaction.editReply(editError("Config not found."));
      }
      return;
    }

    await this.panelHandler.refreshPanelEmbed(guildId, config);

    const seedSummary = `Found **${seed.count}** existing post${seed.count === 1 ? "" : "s"} — all marked as seen.`;

    if (fromMessage) {
      const messageId = interaction.message.id;
      const newLastPage = lastPageIndex(config.connections.length);
      this.currentPage.set(messageId, newLastPage);
      await interaction.editReply(pageToUpdateOptions(buildConnectionsPage(config, {}, newLastPage)));
      await interaction.followUp({
        content: `✅ Added \`${parsed.type}:${parsed.handle}\`. ${seedSummary}`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.editReply({
        content: `✅ Added \`${parsed.type}:${parsed.handle}\`. ${seedSummary}`,
      });
    }
  }
}
