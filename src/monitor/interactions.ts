import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import logger from "../logger";
import {
  MONITOR_POLL_PREFIX,
  REVIEW_EDIT_PREFIX,
  REVIEW_MODAL_PREFIX,
  REVIEW_POST_PREFIX,
  REVIEW_REMOVE_PREFIX,
  REVIEW_SKIP_PREFIX,
} from "./service/review/types";
import type { PanelHandler } from "./handlers/panel";
import type { ReviewHandler } from "./handlers/review";
import type { PostHandler } from "./handlers/post";
import type { ConfigHandler } from "./handlers/config";
import { SETUP_TEMPLATE_MODAL, SETUP_CONNECTION_ADD_MODAL } from "./view/setup";

const log = logger.child({ module: "monitor/interactions" });

async function requireGuildAndPermission(cmd: ChatInputCommandInteraction): Promise<boolean> {
  if (!cmd.guildId) {
    await cmd.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
    return false;
  }
  if (!cmd.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await cmd.reply({
      content: "You need Manage Guild permission to use this command.",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}

export class InteractionDispatcher {
  constructor(
    private readonly panelHandler: PanelHandler,
    private readonly reviewHandler: ReviewHandler,
    private readonly postHandler: PostHandler,
    private readonly configHandler: ConfigHandler,
  ) {}

  async handleInteraction(interaction: Interaction): Promise<void> {
    log.debug(
      {
        type: interaction.type,
        commandName: interaction.isChatInputCommand() ? interaction.commandName : undefined,
        guildId: interaction.guildId,
      },
      "Monitor handleInteraction",
    );
    try {
      if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
      } else if (interaction.isButton()) {
        // Poll panel and review buttons are routed globally.
        // Setup panel buttons are handled by their per-message collector.
        const { customId } = interaction;
        if (customId.startsWith(MONITOR_POLL_PREFIX)) {
          await this.panelHandler.handlePollButton(interaction, customId.slice(MONITOR_POLL_PREFIX.length));
        } else if (customId.startsWith(REVIEW_EDIT_PREFIX)) {
          await this.reviewHandler.handleEdit(interaction, customId.slice(REVIEW_EDIT_PREFIX.length));
        } else if (customId.startsWith(REVIEW_POST_PREFIX)) {
          await this.reviewHandler.handlePost(interaction, customId.slice(REVIEW_POST_PREFIX.length));
        } else if (customId.startsWith(REVIEW_SKIP_PREFIX)) {
          await this.reviewHandler.handleSkip(interaction, customId.slice(REVIEW_SKIP_PREFIX.length));
        } else {
          // Setup panel buttons are handled by their per-message collector.
          // If the collector has expired (5-min timeout), acknowledge to avoid "interaction failed".
          await interaction.deferUpdate();
        }
      } else if (interaction.isStringSelectMenu()) {
        // Review remove select
        const { customId } = interaction;
        if (customId.startsWith(REVIEW_REMOVE_PREFIX)) {
          await this.reviewHandler.handleRemove(interaction, customId.slice(REVIEW_REMOVE_PREFIX.length));
        }
      } else if (interaction.isChatInputCommand()) {
        await this.handleChatCommand(interaction);
      }
    } catch (err) {
      log.error(err, "Unhandled error in monitor interaction handler");
      try {
        if (interaction.isRepliable() && !interaction.replied) {
          if (!interaction.deferred) {
            await interaction.reply({ content: "An error occurred. Please try again.", flags: MessageFlags.Ephemeral });
          } else {
            await interaction.followUp({ content: "An error occurred. Please try again.", flags: MessageFlags.Ephemeral });
          }
        }
      } catch {
        // Ignore — interaction may have already expired
      }
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const { customId } = interaction;

    if (customId === SETUP_TEMPLATE_MODAL) {
      await this.configHandler.handleTemplateModalSubmit(interaction);
    } else if (customId === SETUP_CONNECTION_ADD_MODAL) {
      await this.configHandler.handleConnectionAddModalSubmit(interaction);
    } else if (customId.startsWith(REVIEW_MODAL_PREFIX)) {
      await this.reviewHandler.handleModalSubmit(interaction, customId.slice(REVIEW_MODAL_PREFIX.length));
    } else {
      await interaction.deferUpdate();
    }
  }

  private async handleChatCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    switch (cmd.commandName) {
      case "fetch-all":
        if (!await requireGuildAndPermission(cmd)) return;
        await this.panelHandler.handleFetchAll(cmd);
        break;
      case "post":
        if (!await requireGuildAndPermission(cmd)) return;
        await this.postHandler.handlePostCommand(cmd);
        break;
      case "monitor":
        await this.handleMonitorCommand(cmd);
        break;
      default:
        log.warn({ commandName: cmd.commandName }, "Unrecognized command received by monitor handler");
        await cmd.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
    }
  }

  private async handleMonitorCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    if (!await requireGuildAndPermission(cmd)) return;

    const group = cmd.options.getSubcommandGroup(false);
    const sub = cmd.options.getSubcommand(true);

    if (!group && sub === "setup") {
      await this.configHandler.handleSetupCommand(cmd);
      return;
    }

    if (group === "panel" && sub === "refresh") {
      await this.panelHandler.handlePanelRefresh(cmd);
      return;
    }

    log.warn({ group, sub }, "Unrecognized monitor subcommand");
    await cmd.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
  }
}
