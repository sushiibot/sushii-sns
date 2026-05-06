import {
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type Client,
} from "discord.js";
import logger from "../logger";

const log = logger.child({ module: "monitor/log-channel" });

export async function sendMonitorLog(
  client: Client,
  logChannelId: string | null | undefined,
  message: string,
): Promise<void> {
  if (!logChannelId) return;

  try {
    const channel = await client.channels.fetch(logChannelId);
    if (!channel || !channel.isSendable()) return;
    await channel.send({
      components: [
        new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(message),
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    log.warn({ err, logChannelId }, "Failed to send monitor log message");
  }
}
