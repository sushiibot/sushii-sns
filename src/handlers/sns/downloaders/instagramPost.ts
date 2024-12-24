import {
  Attachment,
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import type { APIMedia, TweetAPIResponse } from "./../fxtweet";
import { chunkArray, itemsToMessageContents } from "../../util";
import {
  SnsDownloader,
  type InstagramMetadata,
  type PostData,
  type ProgressFn,
  type SnsLink,
  type TwitterMetadata,
} from "./base";
import {
  fetchWithHeaders,
  formatDiscordTitle,
  getFileExtFromURL,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "./util";
import logger from "../../../logger";
import config from "../../../config/config";
import {
  BdMonitorResponseSchema,
  BdTriggerResponseSchema,
  type BdMonitorResponse,
  type BdTriggerResponse,
} from "../bd";
import { sleep } from "bun";
import {
  InstagramPostListSchema,
  type InstagramPostElement,
} from "../instagram";

const log = logger.child({ module: "InstagramPostDownloader" });

export class InstagramPostDownloader extends SnsDownloader<InstagramMetadata> {
  URL_REGEX = new RegExp(
    /https?:\/\/(?:www\.)?instagram\.com\/(?:([\w.]+)\/reels?\/|(?:p|reels?|tv)\/)([\w-]+)\//gi
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray
  ): SnsLink<InstagramMetadata> {
    return {
      url: match[0],
      metadata: {
        platform: "instagram",
      },
    };
  }

  buildApiRequest(details: SnsLink<InstagramMetadata>): Request {
    return new Request(
      "https://api.brightdata.com/datasets/v3/trigger?dataset_id=gd_lk5ns7kz21pck8jpis&include_errors=true",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.BD_API_TOKEN}`,
        },
        body: JSON.stringify([{ url: details.url }]),
      }
    );
  }

  async waitUntilDataReady(snapshotID: string): Promise<void> {
    const req = new Request(
      `https://api.brightdata.com/datasets/v3/progress/${snapshotID}`,
      {
        headers: {
          Authorization: `Bearer ${config.BD_API_TOKEN}`,
        },
      }
    );

    // set time to cancel by, 10 seconds later
    let cancelAt = Date.now() + 10 * 1000;

    let resParsed: BdMonitorResponse;
    while (true) {
      const res = await fetch(req);

      // Might be too fast, retry at least 5 times
      if (res.status === 404) {
        if (Date.now() > cancelAt) {
          log.error(
            {
              requestURL: res.url,
              responseCode: res.status,
              responseBody: await res.text(),
            },
            "Failed to fetch ig API snapshot response"
          );

          throw new Error("Failed to fetch ig API response");
        }

        // Wait a bit
        await sleep(500);

        continue;
      }

      if (res.status !== 200) {
        log.error(
          {
            responseCode: res.status,
            responseBody: await res.text(),
          },
          "Failed to fetch ig API snapshot response"
        );

        throw new Error("Failed to fetch ig API response");
      }

      const resJson = await res.json();

      resParsed = BdMonitorResponseSchema.parse(resJson);
      if (resParsed.status === "failed") {
        log.error(
          {
            resParsed,
          },
          "IG API failed to process the post"
        );

        throw new Error("IG API failed to process the post");
      }

      // Done, break loop
      if (resParsed.status === "ready") {
        break;
      }
    }
  }

  async fetchSnapshotData(snapshotID: string): Promise<InstagramPostElement> {
    const req = new Request(
      `https://api.brightdata.com/datasets/v3/snapshot/${snapshotID}?format=json`,
      {
        headers: {
          Authorization: `Bearer ${config.BD_API_TOKEN}`,
        },
      }
    );

    const response = await fetch(req);

    if (response.status !== 200) {
      log.error(
        {
          responseCode: response.status,
          responseBody: await response.text(),
        },
        "Failed to fetch ig API snapshot response"
      );

      throw new Error("Failed to fetch ig API response");
    }

    try {
      const rawJson = await response.json();
      // List of posts
      const posts = InstagramPostListSchema.parse(rawJson);
      if (posts.length === 0) {
        throw new Error("No Instagram posts found");
      }

      // Only one post
      return posts[0];
    } catch (err) {
      log.error(
        {
          err,
          response,
          responseCode: response.status,
        },
        "Failed to parse ig API snapshot response"
      );

      throw err;
    }
  }

  async fetchContent(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn
  ): Promise<PostData<InstagramMetadata>[]> {
    const req = this.buildApiRequest(snsLink);
    const response = await fetch(req);

    if (response.status !== 200) {
      log.error(
        {
          request: req.headers,
          responseCode: response.status,
          responseBody: await response.text(),
        },
        "Failed to fetch ig API response"
      );

      throw new Error("Failed to fetch ig API response");
    }

    let triggerResponse: BdTriggerResponse;
    try {
      const rawJson = await response.json();

      // Throws if invalid
      triggerResponse = BdTriggerResponseSchema.parse(rawJson);
    } catch (err) {
      log.error(
        {
          err,
          response,
          responseCode: response.status,
        },
        "Failed to parse ig trigger API response"
      );

      throw new Error("Failed to parse ig JSON response");
    }

    if (!triggerResponse.snapshot_id) {
      throw new Error("Instagram snapshot ID not found");
    }

    // --------------------------------------------------------------------------
    // Wait for process trigger and download the data

    progressCallback?.("Waiting for IG data...");
    log.debug(
      {
        snapshotID: triggerResponse.snapshot_id,
      },
      "Waiting for IG API to process the post"
    );
    await this.waitUntilDataReady(triggerResponse.snapshot_id);

    log.debug(
      {
        snapshotID: triggerResponse.snapshot_id,
      },
      "IG API processed the post, downloading data..."
    );

    progressCallback?.("Downloading images...");

    const igPost = await this.fetchSnapshotData(triggerResponse.snapshot_id);

    log.debug(
      {
        response: igPost,
      },
      "Downloaded and parsed IG API response"
    );

    if (!igPost.post_content) {
      throw new Error("Instagram post content not found");
    }

    if (igPost.post_content.length === 0) {
      throw new Error("No Instagram post content found");
    }

    const mediaUrls = igPost.post_content
      .map((m) => m.url)
      .filter((x): x is string => !!x);

    log.debug(
      {
        mediaUrls: mediaUrls.length,
      },
      "Downloading media URLs"
    );

    const buffers = await this.downloadImages(mediaUrls);

    const files = buffers.map((buf, i) => {
      return {
        ext: getFileExtFromURL(mediaUrls![i]),
        buffer: buf,
      };
    });

    progressCallback?.("Downloaded!", true);

    return [
      {
        postLink: {
          ...snsLink,
          url: igPost.url ?? snsLink.url,
        },
        username: igPost.user_posted || "Unknown user",
        postID: igPost.post_id || "Unknown ID",
        originalText: igPost.description || "",
        timestamp: igPost.timestamp,
        files,
      },
    ];
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<InstagramMetadata>
  ): MessageCreateOptions[] {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer).setName(
        `ig-${postData.username}-${postData.postID}-${i + 1}.${file.ext}`
      )
    );

    // Groups of 10
    const attachmentsChunks = chunkArray(
      attachments,
      MAX_ATTACHMENTS_PER_MESSAGE
    );

    return attachmentsChunks.map((chunk) => {
      return {
        content: "PLS DON'T DELETE ME !!! or it will break the image links",
        files: chunk,
      };
    });
  }

  buildDiscordMessages(
    postData: PostData<InstagramMetadata>,
    attachmentURLs: string[]
  ): MessageCreateOptions[] {
    let msgs: MessageCreateOptions[] = [];

    let mainPostContent = "";
    mainPostContent += formatDiscordTitle(
      "instagram",
      postData.username,
      postData.timestamp
    );
    mainPostContent += "\n";
    mainPostContent += `<${postData.postLink.url}>`;
    mainPostContent += "\n";

    // Image URLs can be span multiple messages
    const msgChunkContents = itemsToMessageContents(
      mainPostContent,
      attachmentURLs
    );

    const msgChunks: MessageCreateOptions[] = msgChunkContents.map((chunk) => ({
      content: chunk,
      // Prevent embeds
      flags: MessageFlags.SuppressEmbeds,
    }));

    msgs.push(...msgChunks);
    return msgs;
  }
}
