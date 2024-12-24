import {
  Attachment,
  managerToFetchingStrategyOptions,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import {
  SnsDownloader,
  type AnySnsMetadata,
  type InstagramMetadata,
  type PostData,
  type ProgressFn,
  type SnsLink,
  type SnsMetadata,
  type TwitterMetadata,
} from "./downloaders/base";
import logger from "../../logger";
import { sleep } from "bun";
import { TwitterDownloader } from "./downloaders/twitter";
import { InstagramPostDownloader } from "./downloaders/instagramPost";
import { InstagramStoryDownloader } from "./downloaders/instagramStory";

const log = logger.child({ module: "snsHandler" });

const twitterDownloader: SnsDownloader<TwitterMetadata> =
  new TwitterDownloader();
const instagramDownloader: SnsDownloader<InstagramMetadata> =
  new InstagramPostDownloader();
const instagramStoryDownloader: SnsDownloader<InstagramMetadata> =
  new InstagramStoryDownloader();

function findAllSnsLinks(content: string): SnsLink<AnySnsMetadata>[] {
  const twitterLinks = twitterDownloader.findUrls(content);
  const instagramLinks = instagramDownloader.findUrls(content);
  const instagramStoryLinks = instagramStoryDownloader.findUrls(content);

  return [...twitterLinks, ...instagramLinks, ...instagramStoryLinks];
}

function getPlatform<M extends SnsMetadata>(
  metadata: M,
): SnsDownloader<AnySnsMetadata> {
  switch (metadata.platform) {
    case "twitter":
      return twitterDownloader;
    case "instagram":
      return instagramDownloader;
    case "instagram-story":
      return instagramStoryDownloader;
    default:
      throw new Error(`Unsupported platform: ${metadata.platform}`);
  }
}

async function* snsService(
  snsLinks: SnsLink<AnySnsMetadata>[],
  processFn?: ProgressFn,
): AsyncGenerator<PostData<AnySnsMetadata>[]> {
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
    "Processing sns message",
  );

  const posts = findAllSnsLinks(msg.content);

  if (posts.length === 0) {
    log.debug(
      { requester: msg.author.username, content: msg.content },
      "No sns posts found",
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

  let progressMsg: Message | null = null;
  const progressUpdater = async (content: string, done?: boolean) => {
    try {
      // Delete when done
      if (done && progressMsg) {
        await progressMsg.delete();
        return;
      }

      // Edit if exists
      if (progressMsg) {
        await progressMsg.edit(content);
        return;
      }

      // Send if not exists
      progressMsg = await msg.channel.send(content);
    } catch (err) {
      logger.error(err, "failed to send sns progress update message");
    }
  };

  try {
    for await (const postDatas of snsService(posts, progressUpdater)) {
      for (const postData of postDatas) {
        const platform = getPlatform(postData.postLink.metadata);

        // 1. Send images first
        // 2. Get the links to images
        // 3. Send the message with the links
        const fileMsgs = platform.buildDiscordAttachments(postData);

        const attachments: Attachment[] = [];

        for (const fileMsg of fileMsgs) {
          const filesMsg = await msg.channel.send(fileMsg);
          attachments.push(...filesMsg.attachments.values());
        }

        const links = attachments.map((attachment) => attachment.url);
        const msgs = platform.buildDiscordMessages(postData, links);

        for (const postMsg of msgs) {
          await msg.reply({
            ...postMsg,
            allowedMentions: { parse: [] },
          });
        }
      }
    }
  } catch (err) {
    logger.error(err, "failed to process sns message");
    let errMsg =
      "oops borked the download try again or go download it urself lol sorry 💀";
    errMsg += "\n\n<@150443906511667200> pls fix\n";

    await msg.channel.send(errMsg);
  }
}
