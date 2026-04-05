import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
} from "discord.js";
import { chunkArray } from "../../utils/discord";
import type { LastFetch } from "../data/repository";
import {
  MONITOR_FETCH_PREFIX,
  MONITOR_STATUS_PREFIX,
} from "../service/review/types";

export function buildStatusEmbed(
  igUsername: string,
  cooldownSeconds: number,
  lastFetch: LastFetch | null,
): Pick<MessageCreateOptions, "embeds" | "components"> {
  const now = Math.floor(Date.now() / 1000);

  let lastFetchedValue: string;
  let nextFetchValue: string;

  if (lastFetch) {
    const lastFetchedSec = Math.floor(lastFetch.last_fetched_at / 1000);
    lastFetchedValue = `<t:${lastFetchedSec}:R> by ${lastFetch.last_fetched_by}`;

    const nextFetchSec = lastFetchedSec + cooldownSeconds;
    if (now >= nextFetchSec) {
      nextFetchValue = "Now";
    } else {
      nextFetchValue = `<t:${nextFetchSec}:R>`;
    }
  } else {
    lastFetchedValue = "Never";
    nextFetchValue = "Now";
  }

  const embed = new EmbedBuilder()
    .setColor(0xe1306c)
    .setTitle(`📸 Instagram Monitor: @${igUsername}`)
    .addFields(
      { name: "Last fetched", value: lastFetchedValue, inline: true },
      { name: "Next fetch available", value: nextFetchValue, inline: true },
    );

  const fetchButton = new ButtonBuilder()
    .setCustomId(`${MONITOR_FETCH_PREFIX}${igUsername}`)
    .setLabel("Fetch New Posts")
    .setEmoji("📥")
    .setStyle(ButtonStyle.Primary);

  const statusButton = new ButtonBuilder()
    .setCustomId(`${MONITOR_STATUS_PREFIX}${igUsername}`)
    .setLabel("Status")
    .setEmoji("ℹ️")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    fetchButton,
    statusButton,
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

export type PanelConnectionMeta = {
  connectionId: string;
  label: string;
  cooldownSeconds: number;
  lastFetch: LastFetch | null;
};

function typeToEmoji(connectionId: string): string {
  if (connectionId.startsWith("instagram:")) return "📸";
  if (connectionId.startsWith("tiktok:")) return "🎵";
  if (connectionId.startsWith("twitter:")) return "🐦";
  return "🔎";
}

function typeToButtonStyle(connectionId: string): ButtonStyle {
  if (connectionId.startsWith("instagram:")) return ButtonStyle.Primary;
  if (connectionId.startsWith("tiktok:")) return ButtonStyle.Success;
  if (connectionId.startsWith("twitter:")) return ButtonStyle.Secondary;
  return ButtonStyle.Danger;
}

export function buildPanelEmbed(
  connections: PanelConnectionMeta[],
): Pick<MessageCreateOptions, "embeds" | "components"> {
  const now = Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0xe1306c)
    .setTitle("📡 SNS Monitor Panel")
    .setDescription("Click a Poll button to fetch the latest posts for that connection.");

  const fields = connections.map((c) => {
    let lastFetchedValue: string;
    let nextFetchValue: string;

    if (c.lastFetch) {
      const lastFetchedSec = Math.floor(c.lastFetch.last_fetched_at / 1000);
      lastFetchedValue = `<t:${lastFetchedSec}:R> by ${c.lastFetch.last_fetched_by}`;

      const nextFetchSec = lastFetchedSec + c.cooldownSeconds;
      if (now >= nextFetchSec) {
        nextFetchValue = "Now";
      } else {
        nextFetchValue = `<t:${nextFetchSec}:R>`;
      }
    } else {
      lastFetchedValue = "Never";
      nextFetchValue = "Now";
    }

    return {
      name: c.label,
      value: `Last fetched: ${lastFetchedValue}\nNext poll: ${nextFetchValue}`,
      inline: true,
    };
  });

  embed.addFields(fields);

  const buttons = connections.map((c) =>
    new ButtonBuilder()
      .setCustomId(`monitor:poll:${c.connectionId}`)
      .setLabel(c.connectionId.split(":")[1] ?? c.label)
      .setEmoji(typeToEmoji(c.connectionId))
      .setStyle(typeToButtonStyle(c.connectionId)),
  );

  const rows = chunkArray(buttons, 5).map(
    (group) => new ActionRowBuilder().addComponents(group),
  );

  return {
    embeds: [embed],
    components: rows as any,
  };
}
