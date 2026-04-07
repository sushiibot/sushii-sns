import type { Client, SendableChannels } from "discord.js";
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
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    await (channel as SendableChannels).send({ content: message });
  } catch (err) {
    log.warn({ err, logChannelId }, "Failed to send monitor log message");
  }
}
