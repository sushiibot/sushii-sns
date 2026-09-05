import type { Message, MessageContextMenuCommandInteraction } from "discord.js";
import { MessageFlags } from "discord.js";
import config from "../config/config";
import logger from "../logger";
import { itemsToMessageContents } from "../utils/discord";

const log = logger.child({ module: "handleExtractLinksContextMenu" });

/**
 * Builds the reply contents for the "extract links" feature given the
 * target message. Content-based extraction only works here because
 * interaction payloads (context menu targets) always carry full message
 * content, unlike gateway/REST message content which is gated by the
 * privileged Message Content intent the bot no longer has.
 */
function buildLinksReplyContents(targetMsg: Message): string[] {
  if (targetMsg.attachments.size === 0) {
    if (targetMsg.content.includes("https://")) {
      return [targetMsg.content];
    }

    return ["No attachments found in that message noob"];
  }

  return itemsToMessageContents(
    "",
    targetMsg.attachments.map((a) => a.url),
  );
}

export async function handleExtractLinksContextMenu(
  interaction: MessageContextMenuCommandInteraction,
): Promise<void> {
  if (!interaction.channelId || !config.CHANNEL_ID_WHITELIST.includes(interaction.channelId)) {
    await interaction.reply({
      content: "This command isn't available in this channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetMsg = interaction.targetMessage;

  log.debug(
    {
      requester: interaction.user.username,
      targetMsgID: targetMsg.id,
      targetMsgAttachments: targetMsg.attachments.size,
    },
    "Extracting links from message",
  );

  const msgs = buildLinksReplyContents(targetMsg);

  try {
    await interaction.reply({
      content: msgs[0],
      flags: MessageFlags.SuppressEmbeds,
    });

    for (const msgContent of msgs.slice(1)) {
      await interaction.followUp({
        content: msgContent,
        flags: MessageFlags.SuppressEmbeds,
      });
    }
  } catch (err) {
    log.error(err, "Failed to send links");

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp("oops couldnt get links");
    } else {
      await interaction.reply("oops couldnt get links");
    }
  }
}
