import {
  managerToFetchingStrategyOptions,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import {
  InstagramPostDownloader,
  SnsDownloader,
  TwitterDownloader,
  type AnySnsMetadata,
  type InstagramMetadata,
  type PostData,
  type SnsLink,
  type SnsMetadata,
  type TwitterMetadata,
} from "./twitter";
import logger from "../../logger";
import { sleep } from "bun";

const log = logger.child({ module: "snsHandler" });

const twitterDownloader: SnsDownloader<TwitterMetadata> =
  new TwitterDownloader();
const instagramDownloader: SnsDownloader<InstagramMetadata> =
  new InstagramPostDownloader();

function findAllSnsLinks(content: string): SnsLink<AnySnsMetadata>[] {
  const twitterLinks = twitterDownloader.findUrls(content);
  const instagramLinks = instagramDownloader.findUrls(content);

  return [...twitterLinks, ...instagramLinks];
}

function getPlatform<M extends SnsMetadata>(
  metadata: M
): SnsDownloader<AnySnsMetadata> {
  switch (metadata.platform) {
    case "twitter":
      return twitterDownloader;
    case "instagram":
      return instagramDownloader;
    default:
      throw new Error(`Unsupported platform: ${metadata.platform}`);
  }
}

async function* snsService(
  snsLinks: SnsLink<AnySnsMetadata>[],
  processFn?: (content: string) => Promise<void>
): AsyncGenerator<PostData<AnySnsMetadata>> {
  for (const snsLink of snsLinks) {
    const platform = getPlatform(snsLink.metadata);

    const content = await platform.fetchContent(snsLink, processFn);

    // Generator yields the message
    yield content;
  }
}

export async function snsHandler(msg: Message<true>): Promise<void> {
  if (!msg.channel.isSendable()) {
    return;
  }

  if (!msg.content.startsWith("dl")) {
    return;
  }

  log.debug(
    { requester: msg.author.username, content: msg.content },
    "Processing sns message"
  );

  const posts = findAllSnsLinks(msg.content);

  if (posts.length === 0) {
    log.debug(
      { requester: msg.author.username, content: msg.content },
      "No sns posts found"
    );

    return;
  }

  // Only if there are posts to process
  // Don't wait for acks
  Promise.all([
    msg.suppressEmbeds(true),
    msg.react("🤓"),
    msg.channel.sendTyping(),
  ]).catch((err) => logger.error(err, "failed to suppress/react/type"));

  const progressUpdater = async (content: string) => {
    try {
      const progressMsg = await msg.channel.send(content);
      await sleep(5000);
      await progressMsg.delete();
    } catch (err) {
      logger.error(err, "failed to send sns progress update message");
    }
  };

  try {
    for await (const postData of snsService(posts, progressUpdater)) {
      const platform = getPlatform(postData.postLink.metadata);

      // 1. Send images first
      // 2. Get the links to images
      // 3. Send the message with the links
      const filesMsgOpts = platform.buildDiscordAttachments(postData);
      const filesMsg = await msg.channel.send(filesMsgOpts);

      const links = filesMsg.attachments.map((attachment) => attachment.url);
      const msgs = platform.buildDiscordMessages(postData, links);

      for (const postMsg of msgs) {
        await msg.reply({
          ...postMsg,
          allowedMentions: { parse: [] },
        });
      }
    }
  } catch (err) {
    logger.error(err, "failed to process sns message");

    await msg.channel.send(
      "oops borked the download try again or go download it urself lol sorry 💀"
    );
  }
}
