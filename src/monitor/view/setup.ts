import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { MonitorsConfig } from "../config";
import { getConnectionId } from "../config";
import { DEFAULT_INLINE_TEMPLATE, DEFAULT_LINKS_TEMPLATE } from "../../utils/template";
import type { GuildChannelSettings } from "../data/queries";

// ---------------------------------------------------------------------------
// Custom IDs
// ---------------------------------------------------------------------------

export const SETUP_PANEL_CHANNEL_SELECT = "monitor:setup:panel_channel";
export const SETUP_SOCIALS_CHANNEL_SELECT = "monitor:setup:socials_channel";
export const SETUP_TRIGGER_ROLE_SELECT = "monitor:setup:trigger_role";
export const SETUP_TEMPLATE_BTN = "monitor:setup:template";
export const SETUP_NAV_CONNECTIONS = "monitor:setup:nav:connections";
export const SETUP_NAV_SETTINGS = "monitor:setup:nav:settings";
export const SETUP_ADD_CONNECTION_BTN = "monitor:setup:connection:add";
export const SETUP_REMOVE_CONNECTION_PFX = "monitor:setup:connection:remove:";
export const SETUP_CONNECTION_CHANNEL_PFX = "monitor:setup:connection:channel:";
export const SETUP_TEMPLATE_MODAL = "monitor:setup:template:modal";
export const SETUP_CONNECTION_ADD_MODAL = "monitor:setup:connection:add:modal";
export const SETUP_NAV_PAGE_PREV = "monitor:setup:nav:page:prev";
export const SETUP_NAV_PAGE_NEXT = "monitor:setup:nav:page:next";

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

export const CONNECTIONS_PER_PAGE = 5;

/** Returns the last valid 0-based page index for a list of `count` connections. */
export function lastPageIndex(count: number): number {
  return Math.max(0, Math.ceil(count / CONNECTIONS_PER_PAGE) - 1);
}

// ---------------------------------------------------------------------------
// Page builders
// ---------------------------------------------------------------------------

export type SetupPageOptions = {
  disabled?: boolean;
  expired?: boolean;
};

/**
 * Shared shape returned by both page builders.
 * `flags: number` is compatible with InteractionReplyOptions, InteractionUpdateOptions,
 * and MessageEditOptions — avoiding BitField union incompatibilities.
 */
export type SetupPage = {
  components: ContainerBuilder[];
  flags: number;
  embeds: [];
  allowedMentions: { parse: [] };
};

/**
 * Strip `flags` from a SetupPage for use with `interaction.update()`.
 * Discord.js's update() type does not include flags in its payload.
 */
export function pageToUpdateOptions(page: SetupPage): Omit<SetupPage, "flags"> {
  const { flags: _flags, ...rest } = page;
  return rest;
}

/**
 * Page 1 — Settings.
 *
 * `pending` holds uncommitted channel/role values for first-time setup (before
 * both required fields are present to save). Merged over `config` at render time.
 */
export function buildSettingsPage(
  config: MonitorsConfig | null,
  pending: Partial<GuildChannelSettings> | null,
  opts: SetupPageOptions = {},
): SetupPage {
  const { disabled = false, expired = false } = opts;

  const eff = {
    panel_channel_id: pending?.panel_channel_id ?? config?.panel_channel_id ?? null,
    socials_channel_id: pending?.socials_channel_id ?? config?.socials_channel_id ?? null,
    trigger_role_id: pending?.trigger_role_id ?? config?.trigger_role_id ?? null,
    format: config?.format ?? "inline",
    template: config?.template ?? "",
  };

  const container = new ContainerBuilder();

  // --- Header ---
  let header = "## 📋 Monitor Setup — Settings";
  if (expired) {
    header += "\n\n> ⏱️ This setup session has expired. Run `/monitor setup` to start a new one.";
  } else if (!eff.panel_channel_id || !eff.socials_channel_id) {
    header += "\n\n> Select a **Panel channel** and a **Socials channel** below to get started.";
    if (eff.panel_channel_id && !eff.socials_channel_id) {
      header += `\n> Panel channel set to <#${eff.panel_channel_id}>. Now select the socials channel.`;
    }
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));

  // --- Panel channel ---
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `📡 **Panel channel:** ${eff.panel_channel_id ? `<#${eff.panel_channel_id}>` : "_Not set_"}`,
    ),
  );
  container.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(SETUP_PANEL_CHANNEL_SELECT)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setDefaultChannels(eff.panel_channel_id ? [eff.panel_channel_id] : [])
        .setPlaceholder("Panel channel (where the monitor panel lives)")
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(disabled),
    ),
  );

  // --- Socials channel ---
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `📢 **Socials channel:** ${eff.socials_channel_id ? `<#${eff.socials_channel_id}>` : "_Not set_"}`,
    ),
  );
  container.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(SETUP_SOCIALS_CHANNEL_SELECT)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setDefaultChannels(eff.socials_channel_id ? [eff.socials_channel_id] : [])
        .setPlaceholder("Socials channel (where approved posts are sent)")
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(disabled),
    ),
  );

  // --- Allowed role ---
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `🔒 **Allowed role:** ${eff.trigger_role_id ? `<@&${eff.trigger_role_id}>` : "_Anyone_"}`,
    ),
  );
  container.addActionRowComponents(
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(SETUP_TRIGGER_ROLE_SELECT)
        .setDefaultRoles(eff.trigger_role_id ? [eff.trigger_role_id] : [])
        .setPlaceholder("Allowed role — leave empty to allow anyone to refresh")
        .setMinValues(0)
        .setMaxValues(1)
        .setDisabled(disabled),
    ),
  );

  // --- Template & format ---
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const formatDesc =
    eff.format === "inline"
      ? "Attach media files"
      : "Links to media files";
  const effectiveTemplate =
    eff.template ||
    (eff.format === "links" ? DEFAULT_LINKS_TEMPLATE : DEFAULT_INLINE_TEMPLATE);
  const tmplPreview = `\`\`\`\n${effectiveTemplate.length > 120 ? effectiveTemplate.slice(0, 120) + "…" : effectiveTemplate}\n\`\`\``;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `💬 **Template** · 📝 ${formatDesc}\n${tmplPreview}`,
    ),
  );

  // --- Action buttons ---
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const configSaved = config !== null;

  const templateBtn = new ButtonBuilder()
    .setCustomId(SETUP_TEMPLATE_BTN)
    .setLabel("Edit Post Template")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || !configSaved);

  const connectionsBtn = new ButtonBuilder()
    .setCustomId(SETUP_NAV_CONNECTIONS)
    .setLabel("Connections →")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled || !configSaved);

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(templateBtn, connectionsBtn),
  );

  return {
    components: [container],
    // Cast to number so this object is assignable to both InteractionReplyOptions
    // and MessageEditOptions without a flags union mismatch.
    flags: MessageFlags.IsComponentsV2,
    embeds: [],
    allowedMentions: { parse: [] },
  };
}

/**
 * Page 2 — Connections list with add/remove controls.
 */
export function buildConnectionsPage(
  config: MonitorsConfig,
  opts: SetupPageOptions = {},
  page = 0,
): SetupPage {
  const { disabled = false, expired = false } = opts;
  const totalConnections = config.connections.length;
  const totalPages = Math.ceil(totalConnections / CONNECTIONS_PER_PAGE);
  const pageConnections = config.connections.slice(page * CONNECTIONS_PER_PAGE, page * CONNECTIONS_PER_PAGE + CONNECTIONS_PER_PAGE);

  const container = new ContainerBuilder();

  let header = `## 📋 Monitor Setup — Connections (${totalConnections})`;
  if (totalPages > 1) {
    header += ` — Page ${page + 1}/${totalPages}`;
  }
  header += `\n\n📢 **Guild default channel:** <#${config.socials_channel_id}> — used for connections with no override`;
  if (expired) {
    header += "\n\n> ⏱️ This setup session has expired. Run `/monitor setup` to start a new one.";
  } else if (totalConnections === 0) {
    header += "\n\n_No connections yet. Add one below._";
  } else {
    header += "\n\nClick **Remove** to delete a connection and reset its history.";
  }

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));

  for (const conn of pageConnections) {
    const connId = getConnectionId(conn);
    const emoji =
      conn.type === "instagram" ? "📸" : conn.type === "tiktok" ? "🎵" : "🐦";
    const platformLabel =
      conn.type === "instagram" ? "Instagram" : conn.type === "tiktok" ? "TikTok" : "Twitter/X";

    let label = `${emoji} **${platformLabel}** · @${conn.handle}`;
    if (conn.profile_name) label += ` · ${conn.profile_name}`;
    if (conn.target_channel_id) {
      label += ` → <#${conn.target_channel_id}>`;
    } else {
      label += " → guild default";
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(label),
    );

    const removeBtn = new ButtonBuilder()
      .setCustomId(`${SETUP_REMOVE_CONNECTION_PFX}${connId}`)
      .setLabel("Remove")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled);

    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(removeBtn),
    );

    container.addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`${SETUP_CONNECTION_CHANNEL_PFX}${connId}`)
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setDefaultChannels(conn.target_channel_id ? [conn.target_channel_id] : [])
          .setPlaceholder("Override channel — leave empty to use guild default")
          .setMinValues(0)
          .setMaxValues(1)
          .setDisabled(disabled),
      ),
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));

  const addBtn = new ButtonBuilder()
    .setCustomId(SETUP_ADD_CONNECTION_BTN)
    .setLabel("+ Add Connection")
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled);

  const settingsBtn = new ButtonBuilder()
    .setCustomId(SETUP_NAV_SETTINGS)
    .setLabel("← Settings")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  if (totalConnections > CONNECTIONS_PER_PAGE) {
    const prevBtn = new ButtonBuilder()
      .setCustomId(SETUP_NAV_PAGE_PREV)
      .setLabel("← Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page === 0);

    const nextBtn = new ButtonBuilder()
      .setCustomId(SETUP_NAV_PAGE_NEXT)
      .setLabel("Next →")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page >= totalPages - 1);

    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(addBtn, settingsBtn, prevBtn, nextBtn),
    );
  } else {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(addBtn, settingsBtn),
    );
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    embeds: [],
    allowedMentions: { parse: [] },
  };
}

// ---------------------------------------------------------------------------
// Modal builders
// ---------------------------------------------------------------------------

export function buildTemplateModal(config: MonitorsConfig, nonce: string): ModalBuilder {
  const formatSelect = new StringSelectMenuBuilder()
    .setCustomId("format")
    .setPlaceholder("Select post format")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Attach media files")
        .setValue("inline")
        .setDescription("Media sent as file attachments on the message")
        .setDefault(config.format === "inline"),
      new StringSelectMenuOptionBuilder()
        .setLabel("Links to media files")
        .setValue("links")
        .setDescription("Media uploaded to Discord CDN, posted as embeddable links")
        .setDefault(config.format === "links"),
    );

  const templateInput = new TextInputBuilder()
    .setCustomId("template")
    .setLabel("Post text template (leave blank for default)")
    .setStyle(TextInputStyle.Paragraph)
    .setValue(config.template)
    .setRequired(false)
    .setMaxLength(2000);

  return new ModalBuilder()
    .setCustomId(`${SETUP_TEMPLATE_MODAL}:${nonce}`)
    .setTitle("Post Format & Template")
    .addComponents(
      new LabelBuilder()
        .setLabel("Post format")
        .setStringSelectMenuComponent(formatSelect),
      new ActionRowBuilder<TextInputBuilder>().addComponents(templateInput),
    );
}

export function buildConnectionAddModal(nonce: string): ModalBuilder {
  const urlInput = new TextInputBuilder()
    .setCustomId("url")
    .setLabel("Profile URL")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("https://www.instagram.com/username/")
    .setRequired(true)
    .setMaxLength(500);

  return new ModalBuilder()
    .setCustomId(`${SETUP_CONNECTION_ADD_MODAL}:${nonce}`)
    .setTitle("Add Monitor Connection")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(urlInput),
    );
}
