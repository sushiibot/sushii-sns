import {
  ActionRowBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import logger from "../../logger";
import { ConnectionTypeSchema, getConnectionId } from "../config";
import type { MonitorRepository } from "../data/repository";

const log = logger.child({ module: "monitor/handlers/config" });

export const CONFIG_TEMPLATE_MODAL_ID = "monitor:config:template";
export const CONNECTION_ADD_MODAL_ID = "monitor:connection:add";
export const CONNECTION_REMOVE_SELECT_ID = "monitor:connection:remove";

export class ConfigHandler {
  constructor(private readonly repo: MonitorRepository) {}

  async handleConfigSetup(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.editReply({ content: "Must be used in a guild." });
      return;
    }

    const panelChannel = cmd.options.getChannel("panel_channel", true);
    const socialsChannel = cmd.options.getChannel("socials_channel", true);
    const triggerRole = cmd.options.getRole("trigger_role");
    const logChannel = cmd.options.getChannel("log_channel");

    if (
      panelChannel.type !== ChannelType.GuildText &&
      panelChannel.type !== ChannelType.GuildAnnouncement
    ) {
      await cmd.editReply({ content: "Panel channel must be a text channel." });
      return;
    }
    if (
      socialsChannel.type !== ChannelType.GuildText &&
      socialsChannel.type !== ChannelType.GuildAnnouncement
    ) {
      await cmd.editReply({ content: "Socials channel must be a text channel." });
      return;
    }

    try {
      this.repo.upsertSettings(guildId, {
        panel_channel_id: panelChannel.id,
        socials_channel_id: socialsChannel.id,
        trigger_role_id: triggerRole?.id ?? null,
        log_channel_id: logChannel?.id ?? null,
      });
    } catch (err) {
      log.error({ err, guildId }, "Failed to save monitor settings");
      await cmd.editReply({ content: "Failed to save settings." });
      return;
    }

    const lines = [
      `✅ Monitor settings saved.`,
      `Panel channel: <#${panelChannel.id}>`,
      `Socials channel: <#${socialsChannel.id}>`,
      `Trigger role: ${triggerRole ? `<@&${triggerRole.id}>` : "_(anyone)_"}`,
      `Log channel: ${logChannel ? `<#${logChannel.id}>` : "_(none)_"}`,
      ``,
      `Use \`/monitor config template\` to set format and post text template.`,
    ];
    await cmd.editReply({ content: lines.join("\n") });
  }

  async handleConfigTemplate(cmd: ChatInputCommandInteraction): Promise<void> {
    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

    const existing = this.repo.getConfig(guildId);
    if (!existing) {
      await cmd.reply({ content: "Run `/monitor config setup` first.", flags: MessageFlags.Ephemeral });
      return;
    }

    const formatInput = new TextInputBuilder()
      .setCustomId("format")
      .setLabel("Post format")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("inline  or  links")
      .setValue(existing.format)
      .setRequired(true);

    const templateInput = new TextInputBuilder()
      .setCustomId("template")
      .setLabel("Post text template (leave blank for no text)")
      .setStyle(TextInputStyle.Paragraph)
      .setValue(existing.template)
      .setRequired(false)
      .setMaxLength(2000);

    const modal = new ModalBuilder()
      .setCustomId(CONFIG_TEMPLATE_MODAL_ID)
      .setTitle("Post Format & Template")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(formatInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(templateInput),
      );

    await cmd.showModal(modal);
  }

  async handleConfigTemplateModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

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
      log.error({ err, guildId }, "Failed to save template settings");
      await interaction.reply({ content: "Failed to save template settings.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({
      content: [
        `✅ Template settings saved.`,
        `Format: \`${rawFormat}\``,
        `Template: ${template ? `\`${template}\`` : "_(empty)_"}`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  }

  async handleConfigShow(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.editReply({ content: "Must be used in a guild." });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await cmd.editReply({ content: "No monitor config set up for this server. Use `/monitor config setup`." });
      return;
    }

    const connectionList = config.connections.length > 0
      ? config.connections
          .map((c) => `• \`${c.type}:${c.handle}\``)
          .join("\n")
      : "_(none)_";

    const lines = [
      `**Monitor Config**`,
      `Panel channel: <#${config.panel_channel_id}>`,
      `Socials channel: <#${config.socials_channel_id}>`,
      `Format: \`${config.format}\``,
      `Template: ${config.template ? `\`${config.template}\`` : "_(empty)_"}`,
      `Trigger role: ${config.trigger_role_id ? `<@&${config.trigger_role_id}>` : "_(anyone)_"}`,
      `Log channel: ${config.log_channel_id ? `<#${config.log_channel_id}>` : "_(none)_"}`,
      ``,
      `**Connections (${config.connections.length})**`,
      connectionList,
    ];
    await cmd.editReply({ content: lines.join("\n") });
  }

  async handleConnectionAdd(cmd: ChatInputCommandInteraction): Promise<void> {
    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (!this.repo.getConfig(guildId)) {
      await cmd.reply({ content: "Run `/monitor config setup` first.", flags: MessageFlags.Ephemeral });
      return;
    }

    const typeInput = new TextInputBuilder()
      .setCustomId("type")
      .setLabel("Platform")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("instagram  /  tiktok  /  twitter")
      .setRequired(true);

    const handleInput = new TextInputBuilder()
      .setCustomId("handle")
      .setLabel("Username / handle")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const modal = new ModalBuilder()
      .setCustomId(CONNECTION_ADD_MODAL_ID)
      .setTitle("Add Monitor Connection")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(typeInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(handleInput),
      );

    await cmd.showModal(modal);
  }

  async handleConnectionAddModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

    const rawType = interaction.fields.getTextInputValue("type").trim().toLowerCase();
    const parseResult = ConnectionTypeSchema.safeParse(rawType);
    if (!parseResult.success) {
      await interaction.reply({
        content: `Invalid platform \`${rawType}\`. Must be \`instagram\`, \`tiktok\`, or \`twitter\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const type = parseResult.data;
    const handle = interaction.fields.getTextInputValue("handle").trim();
    if (!handle) {
      await interaction.reply({ content: "Handle cannot be empty.", flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      this.repo.addMonitor(guildId, { type, handle, cooldown_seconds: 300 });
    } catch (err) {
      log.error({ err, guildId, type, handle }, "Failed to add monitor connection");
      await interaction.reply({ content: "Failed to add connection.", flags: MessageFlags.Ephemeral });
      return;
    }

    const connectionId = getConnectionId({ type, handle });
    await interaction.reply({ content: `✅ Added connection \`${connectionId}\`.`, flags: MessageFlags.Ephemeral });
  }

  async handleConnectionRemove(cmd: ChatInputCommandInteraction): Promise<void> {
    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config || config.connections.length === 0) {
      await cmd.reply({ content: "No connections configured.", flags: MessageFlags.Ephemeral });
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(CONNECTION_REMOVE_SELECT_ID)
      .setPlaceholder("Select a connection to remove")
      .addOptions(
        config.connections.map((c) => {
          const id = getConnectionId(c);
          return new StringSelectMenuOptionBuilder().setLabel(id).setValue(id);
        }),
      );

    await cmd.reply({
      content: "Select a connection to remove:",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
  }

  async handleConnectionRemoveSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

    const connectionId = interaction.values[0];
    if (!connectionId) {
      await interaction.reply({ content: "No connection selected.", flags: MessageFlags.Ephemeral });
      return;
    }

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
      await interaction.update({ content: "Failed to remove connection.", components: [] });
      return;
    }

    await interaction.update({ content: `✅ Removed \`${connectionId}\` (and its post history).`, components: [] });
  }

  async handleConnectionList(cmd: ChatInputCommandInteraction): Promise<void> {
    await cmd.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = cmd.guildId;
    if (!guildId) {
      await cmd.editReply({ content: "Must be used in a guild." });
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config || config.connections.length === 0) {
      await cmd.editReply({ content: "No connections configured. Use `/monitor connection add`." });
      return;
    }

    const list = config.connections
      .map((c) => `• \`${c.type}:${c.handle}\``)
      .join("\n");

    await cmd.editReply({ content: `**Connections**\n${list}` });
  }
}
