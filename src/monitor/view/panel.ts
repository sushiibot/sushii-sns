import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
} from "discord.js";
import { chunkArray } from "../../utils/discord";
import type { LastFetch } from "../data/repository";
import logger from "../../logger";
import { MONITOR_POLL_PREFIX } from "../service/review/types";

const log = logger.child({ module: "monitor/view/panel" });

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

  if (connections.length > 25) {
    log.warn(
      { count: connections.length },
      "Too many connections for a single panel embed, truncating to 25",
    );
  }

  const connectionsMeta = connections.slice(0, 25); // Discord limit: 25 embed fields

  const embed = new EmbedBuilder()
    .setColor(0xe1306c)
    .setTitle("📡 SNS Monitor Panel")
    .setDescription("Click a Poll button to fetch the latest posts for that connection.");

  const fields = connectionsMeta.map((c) => {
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

  const buttons = connectionsMeta.map((c) =>
    new ButtonBuilder()
      .setCustomId(`${MONITOR_POLL_PREFIX}${c.connectionId}`)
      .setLabel(c.connectionId.split(":")[1] ?? c.label)
      .setEmoji(typeToEmoji(c.connectionId))
      .setStyle(typeToButtonStyle(c.connectionId)),
  );

  const rows = chunkArray(buttons, 5).map(
    (group) => new ActionRowBuilder<ButtonBuilder>().addComponents(group),
  );

  return {
    embeds: [embed],
    components: rows,
  };
}
