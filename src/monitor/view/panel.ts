import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";
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

type PanelMessage = {
  components: ContainerBuilder[];
  flags: number;
  embeds: [];
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
): PanelMessage {
  const now = Math.floor(Date.now() / 1000);

  if (connections.length > 25) {
    log.warn(
      { count: connections.length },
      "Too many connections for a single panel, truncating to 25",
    );
  }

  const connectionsMeta = connections.slice(0, 25);
  const container = new ContainerBuilder();

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "## 📡 SNS Monitor Panel\nClick a Poll button to fetch the latest posts for that connection.",
    ),
  );

  if (connectionsMeta.length === 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "_No connections configured. Use `/monitor setup` to add one._",
      ),
    );
  } else {
    for (const c of connectionsMeta) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      );

      let statusLine: string;
      if (c.lastFetch) {
        const lastFetchedSec = Math.floor(c.lastFetch.last_fetched_at / 1000);
        const nextFetchSec = lastFetchedSec + c.cooldownSeconds;
        const nextPoll = now >= nextFetchSec ? "Now" : `<t:${nextFetchSec}:R>`;
        statusLine = `${typeToEmoji(c.connectionId)} **${c.label}**\nLast fetched: <t:${lastFetchedSec}:R> by ${c.lastFetch.last_fetched_by} · Next poll: ${nextPoll}`;
      } else {
        statusLine = `${typeToEmoji(c.connectionId)} **${c.label}**\nLast fetched: Never · Next poll: Now`;
      }

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(statusLine),
      );

      const button = new ButtonBuilder()
        .setCustomId(`${MONITOR_POLL_PREFIX}${c.connectionId}`)
        .setLabel(c.connectionId.split(":")[1] ?? c.label)
        .setEmoji(typeToEmoji(c.connectionId))
        .setStyle(typeToButtonStyle(c.connectionId));

      container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(button),
      );
    }
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    embeds: [],
  };
}
