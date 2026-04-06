import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Interaction,
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

export function createInteractionDispatcher(
  panelHandler: PanelHandler,
  reviewHandler: ReviewHandler,
  postHandler: PostHandler,
) {
  return async function handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isStringSelectMenu()) {
        const customId = interaction.customId;
        if (customId.startsWith(REVIEW_REMOVE_PREFIX)) {
          const reviewId = customId.slice(REVIEW_REMOVE_PREFIX.length);
          await reviewHandler.handleRemove(interaction, reviewId);
          return;
        }
      }

      if (interaction.isModalSubmit()) {
        const customId = interaction.customId;
        if (customId.startsWith(REVIEW_MODAL_PREFIX)) {
          const reviewId = customId.slice(REVIEW_MODAL_PREFIX.length);
          await reviewHandler.handleModalSubmit(interaction, reviewId);
          return;
        }
      }

      if (interaction.isButton()) {
        const customId = interaction.customId;

        if (customId.startsWith(MONITOR_POLL_PREFIX)) {
          const connectionId = customId.slice(MONITOR_POLL_PREFIX.length);
          await panelHandler.handlePollButton(interaction, connectionId);
          return;
        }

        if (customId.startsWith(REVIEW_EDIT_PREFIX)) {
          const reviewId = customId.slice(REVIEW_EDIT_PREFIX.length);
          await reviewHandler.handleEdit(interaction, reviewId);
          return;
        }

        if (customId.startsWith(REVIEW_POST_PREFIX)) {
          const reviewId = customId.slice(REVIEW_POST_PREFIX.length);
          await reviewHandler.handlePost(interaction, reviewId);
          return;
        }

        if (customId.startsWith(REVIEW_SKIP_PREFIX)) {
          const reviewId = customId.slice(REVIEW_SKIP_PREFIX.length);
          await reviewHandler.handleSkip(interaction, reviewId);
          return;
        }
      }

      if (interaction.isChatInputCommand()) {
        const cmd = interaction;

        if (cmd.commandName === "fetch-all") {
          await panelHandler.handleFetchAll(cmd);
          return;
        }

        if (cmd.commandName !== "monitor" && cmd.commandName !== "post") {
          log.warn({ commandName: cmd.commandName }, "Unrecognized slash command — command may be registered but missing a dispatch entry");
          return;
        }

        if (!cmd.guildId) {
          await cmd.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
          return;
        }

        if (!checkManageGuild(cmd)) {
          await cmd.reply({
            content: "You need Manage Guild permission to use this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (cmd.commandName === "post") {
          await postHandler.handlePostCommand(cmd);
          return;
        }

        const group = cmd.options.getSubcommandGroup(false);
        const sub = cmd.options.getSubcommand(true);

        if (group === "panel" && sub === "setup") {
          await panelHandler.handlePanelSetup(cmd);
          return;
        }

        if (group === "panel" && sub === "refresh") {
          await panelHandler.handlePanelRefresh(cmd);
          return;
        }

        if (group === "db" && sub === "purge-connection") {
          await panelHandler.handleDbPurgeConnection(cmd);
          return;
        }

        if (group === "db" && sub === "purge-all") {
          await panelHandler.handleDbPurgeAll(cmd);
          return;
        }
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
  };
}
