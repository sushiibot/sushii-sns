import {
  MessageFlags,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
} from "discord.js";
import logger from "../../logger";
import type { ConnectionType } from "../config";
import type { MonitorRepository } from "../data/repository";
import type { GuildChannelSettings } from "../data/queries";
import {
  buildConnectionAddModal,
  buildConnectionsPage,
  buildSettingsPage,
  buildTemplateModal,
  pageToUpdateOptions,
  SETUP_ADD_CONNECTION_BTN,
  SETUP_CONNECTION_ADD_MODAL,
  SETUP_LOG_CHANNEL_SELECT,
  SETUP_NAV_CONNECTIONS,
  SETUP_NAV_SETTINGS,
  SETUP_PANEL_CHANNEL_SELECT,
  SETUP_REMOVE_CONNECTION_PFX,
  SETUP_SOCIALS_CHANNEL_SELECT,
  SETUP_TEMPLATE_BTN,
  SETUP_TEMPLATE_MODAL,
  SETUP_TRIGGER_ROLE_SELECT,
} from "../view/setup";
import type { PanelHandler } from "./panel";

export { SETUP_TEMPLATE_MODAL, SETUP_CONNECTION_ADD_MODAL };

const log = logger.child({ module: "monitor/handlers/config" });

const COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_SECONDS = 300;

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

function parseProfileUrl(url: string): { type: ConnectionType; handle: string } | null {
  const ig = url.match(/instagram\.com\/([A-Za-z0-9_.]+)/);
  if (ig && !["p", "reel", "reels", "stories", "explore"].includes(ig[1])) {
    return { type: "instagram", handle: ig[1].replace(/\/$/, "") };
  }

  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9_.]+)/);
  if (tt) return { type: "tiktok", handle: tt[1].replace(/\/$/, "") };

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

  constructor(
    private readonly repo: MonitorRepository,
    private readonly panelHandler: PanelHandler,
  ) {}

  // ---------------------------------------------------------------------------
  // Slash command entry point
  // ---------------------------------------------------------------------------

  async handleSetupCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    if (!cmd.guildId) {
      await cmd.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
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
    const collector = msg.createMessageComponentCollector({
      time: COLLECTOR_TIMEOUT_MS,
    });

    collector.on("collect", async (interaction) => {
      if (interaction.user.id !== ownerId) {
        await interaction.reply({
          content: "Only the person who opened this panel can use it.",
          flags: MessageFlags.Ephemeral,
        });
        return;
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
            await interaction.reply({
              content: "Something went wrong. Please try again.",
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch { /* ignore */ }
      }
    });

    collector.once("end", async () => {
      this.pendingSettings.delete(messageId);
      try {
        const finalConfig = this.repo.getConfig(guildId);
        const page = buildSettingsPage(finalConfig, null, { disabled: true });
        await msg.edit(page);
      } catch { /* message may have been deleted */ }
    });
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
      const config = this.repo.getConfig(guildId);
      if (!config) {
        await interaction.reply({ content: "Save settings first.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.update(pageToUpdateOptions(buildConnectionsPage(config)));
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
        await interaction.reply({ content: "Save settings first.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.showModal(buildTemplateModal(config));
      return;
    }

    if (customId === SETUP_ADD_CONNECTION_BTN) {
      await interaction.showModal(buildConnectionAddModal());
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
      await interaction.reply({ content: "Invalid connection ID.", flags: MessageFlags.Ephemeral });
      return;
    }
    const type = connectionId.slice(0, colonIdx);
    const handle = connectionId.slice(colonIdx + 1);

    try {
      this.repo.removeMonitor(guildId, type, handle);
    } catch (err) {
      log.error({ err, guildId, connectionId }, "Failed to remove monitor connection");
      await interaction.reply({ content: "Failed to remove connection.", flags: MessageFlags.Ephemeral });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await interaction.reply({ content: "Config not found.", flags: MessageFlags.Ephemeral });
      return;
    }

    await this.panelHandler.refreshPanelEmbed(guildId, config);
    await interaction.update(pageToUpdateOptions(buildConnectionsPage(config)));
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

    let field: keyof GuildChannelSettings | null = null;
    if (customId === SETUP_PANEL_CHANNEL_SELECT) field = "panel_channel_id";
    else if (customId === SETUP_SOCIALS_CHANNEL_SELECT) field = "socials_channel_id";
    else if (customId === SETUP_LOG_CHANNEL_SELECT) field = "log_channel_id";

    if (!field) {
      await interaction.deferUpdate();
      return;
    }

    // Optional selects (min 0) may return empty values to clear
    const newChannelId = interaction.values[0] ?? null;

    const currentConfig = this.repo.getConfig(guildId);

    if (currentConfig) {
      const prevPanelChannel = currentConfig.panel_channel_id;
      this.repo.upsertSettings(guildId, {
        panel_channel_id: currentConfig.panel_channel_id,
        socials_channel_id: currentConfig.socials_channel_id,
        trigger_role_id: currentConfig.trigger_role_id,
        log_channel_id: currentConfig.log_channel_id,
        [field]: newChannelId,
      });

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
          log_channel_id: newPending.log_channel_id ?? null,
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
      this.repo.upsertSettings(guildId, {
        panel_channel_id: currentConfig.panel_channel_id,
        socials_channel_id: currentConfig.socials_channel_id,
        trigger_role_id: newRoleId,
        log_channel_id: currentConfig.log_channel_id,
      });
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

    const rawFormat = interaction.fields.getTextInputValue("format").trim().toLowerCase();
    if (rawFormat !== "inline" && rawFormat !== "links") {
      await interaction.reply({
        content: `Invalid format \`${rawFormat}\`. Must be \`inline\` or \`links\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const template = interaction.fields.getTextInputValue("template").trim();

    try {
      this.repo.upsertTemplate(guildId, rawFormat, template);
    } catch (err) {
      log.error({ err, guildId }, "Failed to save template");
      await interaction.reply({ content: "Failed to save template.", flags: MessageFlags.Ephemeral });
      return;
    }

    const config = this.repo.getConfig(guildId);

    if (interaction.isFromMessage() && config) {
      await interaction.update(pageToUpdateOptions(buildSettingsPage(config, null)));
    } else {
      await interaction.reply({
        content: `✅ Template saved. Format: \`${rawFormat}\``,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  async handleConnectionAddModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) return;

    const url = interaction.fields.getTextInputValue("url").trim();
    const parsed = parseProfileUrl(url);

    if (!parsed) {
      await interaction.reply({
        content: `Could not detect platform from that URL.\nSupported: \`instagram.com\`, \`tiktok.com\`, \`twitter.com\`, \`x.com\``,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      this.repo.addMonitor(guildId, { type: parsed.type, handle: parsed.handle, cooldown_seconds: DEFAULT_COOLDOWN_SECONDS });
    } catch (err) {
      log.error({ err, guildId, ...parsed }, "Failed to add monitor connection");
      await interaction.reply({ content: "Failed to add connection.", flags: MessageFlags.Ephemeral });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await interaction.reply({ content: "Config not found.", flags: MessageFlags.Ephemeral });
      return;
    }

    await this.panelHandler.refreshPanelEmbed(guildId, config);

    if (interaction.isFromMessage()) {
      await interaction.update(pageToUpdateOptions(buildConnectionsPage(config)));
    } else {
      await interaction.reply({
        content: `✅ Added \`${parsed.type}:${parsed.handle}\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
