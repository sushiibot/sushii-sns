import {
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
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

const log = logger.child({ module: "monitor/interactions" });

function checkManageGuild(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.guildId) return false;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return false;
  return true;
}

async function requireGuildAndPermission(cmd: ChatInputCommandInteraction): Promise<boolean> {
  if (!cmd.guildId) {
    await cmd.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
    return false;
  }
  if (!checkManageGuild(cmd)) {
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
  ) {}

  async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isStringSelectMenu()) {
        await this.handleSelectMenu(interaction);
      } else if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
      } else if (interaction.isButton()) {
        await this.handleButton(interaction);
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

  private async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const { customId } = interaction;
    if (customId.startsWith(REVIEW_REMOVE_PREFIX)) {
      await this.reviewHandler.handleRemove(interaction, customId.slice(REVIEW_REMOVE_PREFIX.length));
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const { customId } = interaction;
    if (customId.startsWith(REVIEW_MODAL_PREFIX)) {
      await this.reviewHandler.handleModalSubmit(interaction, customId.slice(REVIEW_MODAL_PREFIX.length));
    }
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const { customId } = interaction;
    if (customId.startsWith(MONITOR_POLL_PREFIX)) {
      await this.panelHandler.handlePollButton(interaction, customId.slice(MONITOR_POLL_PREFIX.length));
    } else if (customId.startsWith(REVIEW_EDIT_PREFIX)) {
      await this.reviewHandler.handleEdit(interaction, customId.slice(REVIEW_EDIT_PREFIX.length));
    } else if (customId.startsWith(REVIEW_POST_PREFIX)) {
      await this.reviewHandler.handlePost(interaction, customId.slice(REVIEW_POST_PREFIX.length));
    } else if (customId.startsWith(REVIEW_SKIP_PREFIX)) {
      await this.reviewHandler.handleSkip(interaction, customId.slice(REVIEW_SKIP_PREFIX.length));
    }
  }

  private async handleChatCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    switch (cmd.commandName) {
      case "fetch-all":
        await this.panelHandler.handleFetchAll(cmd);
        break;
      case "post":
        await this.handlePostCommand(cmd);
        break;
      case "monitor":
        await this.handleMonitorCommand(cmd);
        break;
      default:
        log.warn({ commandName: cmd.commandName }, "Unrecognized command received by monitor handler");
        await cmd.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
    }
  }

  private async handlePostCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    if (!await requireGuildAndPermission(cmd)) return;
    await this.postHandler.handlePostCommand(cmd);
  }

  private async handleMonitorCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    if (!await requireGuildAndPermission(cmd)) return;

    const group = cmd.options.getSubcommandGroup(false);
    switch (group) {
      case "panel":
        await this.handlePanelGroup(cmd);
        break;
      case "db":
        await this.handleDbGroup(cmd);
        break;
      default:
        log.warn({ group }, "Unrecognized monitor subcommand group");
        await cmd.reply({ content: "Unknown subcommand group.", flags: MessageFlags.Ephemeral });
    }
  }

  private async handlePanelGroup(cmd: ChatInputCommandInteraction): Promise<void> {
    const sub = cmd.options.getSubcommand(true);
    switch (sub) {
      case "setup":
        await this.panelHandler.handlePanelSetup(cmd);
        break;
      case "refresh":
        await this.panelHandler.handlePanelRefresh(cmd);
        break;
      default:
        log.warn({ sub }, "Unrecognized monitor panel subcommand");
        await cmd.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
    }
  }

  private async handleDbGroup(cmd: ChatInputCommandInteraction): Promise<void> {
    const sub = cmd.options.getSubcommand(true);
    switch (sub) {
      case "purge-connection":
        await this.panelHandler.handleDbPurgeConnection(cmd);
        break;
      case "purge-all":
        await this.panelHandler.handleDbPurgeAll(cmd);
        break;
      default:
        log.warn({ sub }, "Unrecognized monitor db subcommand");
        await cmd.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
    }
  }
}
