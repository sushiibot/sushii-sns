import {
  Attachment,
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import type { APIMedia, TweetAPIResponse } from "./fxtweet";
import { itemsToMessageContents } from "../util";
import logger from "../../logger";
import {
  InstagramPostElementSchema,
  InstagramPostListSchema,
  type InstagramPostElement,
} from "./instagram";
import {
  BdMonitorResponseSchema,
  BdMonitorStatus,
  BdTriggerResponseSchema,
  type BdMonitorResponse,
  type BdTriggerResponse,
} from "./bd";
import { sleep } from "bun";
import { EventEmitter } from "events";

const log = logger.child({ module: "snsHandler" });

export type Platform = "twitter" | "instagram";

// Generic interfaces to make the downloader more flexible
export interface SnsMetadata {
  // Base interface for platform-specific metadata
  platform: Platform;
}

export interface TwitterMetadata extends SnsMetadata {
  platform: "twitter";
  username: string;
  id: string;
}

export interface InstagramMetadata extends SnsMetadata {
  platform: "instagram";
}

export type AnySnsMetadata = TwitterMetadata | InstagramMetadata;

// Define type guard functions for each metadata type
export function isTwitterMetadata(
  metadata: AnySnsMetadata
): metadata is TwitterMetadata {
  return metadata.platform === "twitter";
}

export function isInstagramMetadata(
  metadata: AnySnsMetadata
): metadata is InstagramMetadata {
  return metadata.platform === "instagram";
}

// --------------------------------------------------------------------------

// Enhanced details of a link
export type SnsLink<M extends SnsMetadata> = {
  metadata: M;
  url: string;
};

export interface File {
  ext: string;
  buffer: Buffer;
}

// Actual details and files of a post
export interface PostData<M extends SnsMetadata> {
  postLink: SnsLink<M>;
  username: string;
  postID: string;
  originalText: string;
  translatedText?: string;
  translatedFromLang?: string;
  files: File[];
}

export function fetchWithHeaders(
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> {
  const headers = new Headers(args[1]?.headers);
  headers.set(
    "User-Agent",
    "Private social media downloader Discord bot: https://github.com/sushiibot/sushii-sns"
  );

  // Append to existing headers
  if (args[1]) {
    args[1].headers = {
      ...args[1].headers,
      ...headers,
    };
  } else {
    // No options provided
    args[1] = {
      headers,
    };
  }

  return fetch(...args);
}

export function getFileExtFromURL(url: string): string {
  const urlObj = new URL(url);
  const ext = urlObj.pathname.split(".").pop() ?? "jpg";

  return ext;
}

export abstract class SnsDownloader<M extends SnsMetadata> {
  /**
   * Regular expression to match platform-specific URLs
   * Implemented by child classes
   */
  protected abstract readonly URL_REGEX: RegExp;

  /**
   * Extract platform-specific post details from content
   * @param content Text to search for platform URLs
   * @returns Array of platform-specific post details
   */
  findUrls(content: string): SnsLink<M>[] {
    const matches = content.matchAll(this.URL_REGEX) ?? [];
    const results: SnsLink<M>[] = [];

    for (const match of matches) {
      results.push(this.createLinkFromMatch(match));
    }

    log.debug(
      {
        content,
        results,
      },
      "Finding URLs in content"
    );

    return results;
  }

  /**
   * Abstract method to create a post object from regex match
   * @param match Regex match result
   * @returns Platform-specific post object
   */
  protected abstract createLinkFromMatch(match: RegExpMatchArray): SnsLink<M>;

  /**
   * Build API fetch request using the extracted details.
   */
  abstract buildApiRequest(details: SnsLink<M>): Request;

  /**
   * Fetch content from the platform's API
   */
  abstract fetchContent(
    snsLink: SnsLink<M>,
    progressCallback?: (message: string) => Promise<void>
  ): Promise<PostData<M>>;

  abstract buildDiscordAttachments(postData: PostData<M>): MessageCreateOptions;

  /**
   * Build a Discord message using the fetched content and images.
   */
  abstract buildDiscordMessages(
    postData: PostData<M>,
    attachmentURLs: string[]
  ): MessageCreateOptions[];

  /**
   * Download images from URLs
   */
  protected async downloadImages(urls: string[]): Promise<Buffer[]> {
    const ps = urls.map(async (url, i) => {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();

      return Buffer.from(buf);
    });

    return Promise.all(ps);
  }
}

export class TwitterDownloader extends SnsDownloader<TwitterMetadata> {
  URL_REGEX = new RegExp(
    "https?://(?:(?:www|m|mobile)\\.)?" +
      "(?:twitter\\.com|x\\.com)" +
      "/(\\w+)/status/(\\d+)(/(?:photo|video)/\\d)?/?(?:\\?\\S+)?(?:#\\S+)?",
    // 'i' flag for case-insensitivity
    // 'g' flag for global search - makes String.match() exclude capture groups
    "ig"
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray
  ): SnsLink<TwitterMetadata> {
    return {
      url: match[0],
      metadata: {
        platform: "twitter",
        username: match[1],
        id: match[2],
      },
    };
  }

  buildApiRequest(details: SnsLink<TwitterMetadata>): Request {
    return new Request(
      `https://api.fxtwitter.com/${details.metadata.username}/status/${details.metadata.id}/en`,
      {
        headers: {
          "User-Agent":
            "Private social media downloader Discord bot: https://github.com/sushiibot/sushii-sns",
        },
      }
    );
  }

  async fetchContent(
    snsLink: SnsLink<TwitterMetadata>
  ): Promise<PostData<TwitterMetadata>> {
    const req = this.buildApiRequest(snsLink);
    const response = await fetchWithHeaders(req);

    let tweetRes: TweetAPIResponse;
    try {
      tweetRes = await response.json();
    } catch (err) {
      log.error(
        {
          err,
          req,
        },
        "Failed to parse tweet API response from"
      );
      throw new Error("Failed to parse tweet JSON response");
    }

    if (tweetRes.code !== 200) {
      throw new Error("Failed to fetch tweet: " + tweetRes.message);
    }

    if (!tweetRes.tweet) {
      throw new Error("Tweet not found: " + tweetRes.message);
    }

    const media = tweetRes.tweet.media.all?.map((m) => ({
      ...m,
      url: this.origTwitterPhotoUrl(m),
    }));

    const buffers = await this.downloadImages(media?.map((m) => m.url) ?? []);

    const files = buffers.map((buf, i) => {
      return {
        ext: getFileExtFromURL(media![i].url),
        buffer: buf,
      };
    });

    return {
      postLink: snsLink,
      username: tweetRes.tweet.author.screen_name,
      postID: tweetRes.tweet.id,
      originalText: tweetRes.tweet.text,
      translatedText: tweetRes.tweet.translation?.text,
      translatedFromLang: tweetRes.tweet.translation?.source_lang_en,
      files,
    };
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<TwitterMetadata>
  ): MessageCreateOptions {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer)
        .setName(
          `twitter-${postData.username}-${postData.postID}-${i}.${file.ext}`
        )
        .setDescription(`${postData.username} - ${postData.postID} - ${i}`)
    );

    return {
      content: "PLS DON'T DELETE ME !!! or it will break the image links",
      files: attachments,
    };
  }

  buildDiscordMessages(
    postData: PostData<TwitterMetadata>,
    attachmentURLs: string[]
  ): MessageCreateOptions[] {
    // Translated or original text
    let textContent;
    if (postData.translatedText) {
      textContent = postData.translatedText;
    } else {
      textContent = postData.originalText;
    }

    textContent += "\n\n";
    textContent += `<https://x.com/${postData.username}/status/${postData.postID}>`;
    textContent += "\n";

    // Image URLs can be span multiple messages
    const imageUrlsChunks = itemsToMessageContents(textContent, attachmentURLs);

    return imageUrlsChunks.map((chunk) => ({
      content: chunk,
      // Prevent embeds
      flags: MessageFlags.SuppressEmbeds,
    }));
  }

  private origTwitterPhotoUrl(media: APIMedia): string {
    return `${media.url}?name=orig`;
  }
}

export class InstagramPostDownloader extends SnsDownloader<InstagramMetadata> {
  URL_REGEX = new RegExp(
    /https?:\/\/(?:www\.)?instagram\.com\/(?:([\w.]+)\/reels?\/|(?:p|reels?|tv)\/)([\w-]+)\/?(?:\?\S+)?/gi
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
          Authorization: `Bearer ${process.env.BD_API_TOKEN}`,
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
          Authorization: `Bearer ${process.env.BD_API_TOKEN}`,
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
          Authorization: `Bearer ${process.env.BD_API_TOKEN}`,
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
    progressCallback?: (message: string) => Promise<void>
  ): Promise<PostData<InstagramMetadata>> {
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

    return {
      postLink: {
        ...snsLink,
        url: igPost.url ?? snsLink.url,
      },
      username: igPost.user_posted || "Unknown user",
      postID: igPost.post_id || "Unknown ID",
      originalText: igPost.description || "",
      files,
    };
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<InstagramMetadata>
  ): MessageCreateOptions {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer)
        .setName(`ig-${postData.username}-${postData.postID}-${i}.${file.ext}`)
        .setDescription(`${postData.username} - ${postData.postID} - ${i + 1}`)
    );

    return {
      content: "PLS DON'T DELETE ME !!! or it will break the image links",
      files: attachments,
    };
  }

  buildDiscordMessages(
    postData: PostData<InstagramMetadata>,
    attachmentURLs: string[]
  ): MessageCreateOptions[] {
    // No translation for ig
    let textContent = postData.originalText;

    textContent += "\n";
    textContent += `<${postData.postLink.url}>`;
    textContent += "\n";

    // Image URLs can be span multiple messages
    const msgChunks = itemsToMessageContents(textContent, attachmentURLs);

    return msgChunks.map((chunk) => ({
      content: chunk,
      // Prevent embeds
      flags: MessageFlags.SuppressEmbeds,
    }));
  }
}
