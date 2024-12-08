import {
  managerToFetchingStrategyOptions,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import {
  TwitterDownloader,
  type PostData,
  type SnsPost,
  type TwitterMetadata,
} from "./twitter";
import logger from "../../logger";

const twitterPlatform = new TwitterDownloader();

async function* snsService(
  posts: SnsPost<TwitterMetadata>[]
): AsyncGenerator<PostData> {
  for (const details of posts) {
    const apiUrl = twitterPlatform.buildApiUrl(details);
    const content = await twitterPlatform.fetchContent(apiUrl);

    // Generator yields the message
    yield content;
  }
}

export async function snsHandler(msg: Message<true>): Promise<void> {
  if (!msg.channel.isSendable()) {
    return;
  }

  const posts = twitterPlatform.findUrls(msg.content);

  if (posts.length === 0) {
    return;
  }

  // Only if there are posts to process
  // Don't wait for acks
  Promise.all([
    msg.suppressEmbeds(true),
    msg.react("🤓"),
    msg.channel.sendTyping(),
  ]).catch((err) => logger.error(err, "failed to suppress/react/type"));

  try {
    for await (const postData of snsService(posts)) {
      // 1. Send images first
      // 2. Get the links to images
      // 3. Send the message with the links
      const filesMsgOpts = twitterPlatform.buildDiscordAttachments(postData);
      const filesMsg = await msg.channel.send(filesMsgOpts);

      const links = filesMsg.attachments.map((attachment) => attachment.url);
      const postMsg = twitterPlatform.buildDiscordMessage(postData, links);

      await msg.channel.send(postMsg);
    }
  } catch (err) {
    logger.error(err, "failed to process sns message");

    await msg.channel.send(
      "oops borked the download try again or go download it urself lol sorry 💀"
    );
  }
}
