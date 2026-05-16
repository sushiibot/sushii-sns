import {
  ActionRowBuilder,
  ButtonBuilder,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import { ACCENT_GREEN, ACCENT_RED, ACCENT_YELLOW } from "./colors";

// ---------------------------------------------------------------------------
// Shared shape — compatible with reply(), followUp(), and editReply()
// ---------------------------------------------------------------------------

export type V2Reply = {
  components: ContainerBuilder[];
  flags: number;
  embeds: [];
};

// ---------------------------------------------------------------------------
// Ephemeral helpers — include MessageFlags.Ephemeral
// Use for: interaction.reply() and interaction.followUp()
// ---------------------------------------------------------------------------

/** Ephemeral error (red accent) — permission denied, not found, failed operations */
export function ephemeralError(message: string): V2Reply {
  return {
    components: [
      new ContainerBuilder()
        .setAccentColor(ACCENT_RED)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(message)),
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    embeds: [],
  };
}

/** Ephemeral warning (yellow accent) — cooldown, already in progress, duplicate */
export function ephemeralWarn(message: string): V2Reply {
  return {
    components: [
      new ContainerBuilder()
        .setAccentColor(ACCENT_YELLOW)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(message)),
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    embeds: [],
  };
}

/** Ephemeral confirmation prompt (yellow accent) with two buttons. */
export function ephemeralConfirm(
  message: string,
  confirmRow: ActionRowBuilder<ButtonBuilder>,
): V2Reply {
  return {
    components: [
      new ContainerBuilder()
        .setAccentColor(ACCENT_YELLOW)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(message))
        .addActionRowComponents(confirmRow),
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    embeds: [],
  };
}

// ---------------------------------------------------------------------------
// Non-ephemeral V2 edit helpers — no Ephemeral flag
// Use for: interaction.editReply() after deferReply(), and msg.edit()
// ---------------------------------------------------------------------------

/** Edit reply — error (red accent). */
export function editError(message: string): V2Reply {
  return {
    components: [
      new ContainerBuilder()
        .setAccentColor(ACCENT_RED)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(message)),
    ],
    flags: MessageFlags.IsComponentsV2,
    embeds: [],
  };
}

/** Edit reply — success (green accent). */
export function editSuccess(message: string): V2Reply {
  return {
    components: [
      new ContainerBuilder()
        .setAccentColor(ACCENT_GREEN)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(message)),
    ],
    flags: MessageFlags.IsComponentsV2,
    embeds: [],
  };
}

/** Edit reply — neutral info (no accent). */
export function editInfo(message: string): V2Reply {
  return {
    components: [
      new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(message),
      ),
    ],
    flags: MessageFlags.IsComponentsV2,
    embeds: [],
  };
}
