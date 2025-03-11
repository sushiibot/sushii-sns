import { Attachment, type Message } from "discord.js";
import logger from "../../logger";
import {
  SnsDownloader,
  type AnySnsMetadata,
  type PostData,
  type ProgressFn,
  type SnsLink,
  type SnsMetadata,
} from "./downloaders/base";
import { InstagramPostDownloader } from "./downloaders/instagramPost";
import { InstagramStoryDownloader } from "./downloaders/instagramStory";
import { TikTokDownloader } from "./downloaders/tiktok";
import { TwitterDownloader } from "./downloaders/twitter";

const log = logger.child({ module: "snsHandler" });

const downloaders = [
  new TwitterDownloader(),
  new InstagramPostDownloader(),
  new InstagramStoryDownloader(),
  new TikTokDownloader(),
];

function findAllSnsLinks(content: string): SnsLink<AnySnsMetadata>[] {
  let snsLinks: SnsLink<AnySnsMetadata>[] = [];
  for (const downloader of downloaders) {
    const urls = downloader.findUrls(content);
    snsLinks = snsLinks.concat(urls);
  }

  return snsLinks;
}

function getPlatform<M extends SnsMetadata>(
  metadata: M,
): SnsDownloader<AnySnsMetadata> {
  const downloader = downloaders.find(
    (downloader) => downloader.PLATFORM === metadata.platform,
  );
  if (!downloader) {
    throw new Error(`Unsupported platform: ${metadata.platform}`);
  }

  return downloader;
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

  const reaction_emojis = [
    "👍",
    "<:jenniekek2:821808883810041876>",
    "<a:aJennieMock:807147252673675275>",
    "<a:aJennieLaugh:695359047775289364>",
  ];

  const reaction =
    reaction_emojis[Math.floor(Math.random() * reaction_emojis.length)];

  // Only if there are posts to process
  // Don't wait for acks
  Promise.all([
    msg.suppressEmbeds(true),
    msg.react(reaction),
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
    let errMsg = "oops borked the download, pls try again!!";
    errMsg += `\n\n<@150443906511667200> Error: ${err}\n`;

    await msg.channel.send(errMsg);
  }
}
