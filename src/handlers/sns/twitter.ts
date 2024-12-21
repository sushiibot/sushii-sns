import {
  Attachment,
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import type { APIMedia, TweetAPIResponse } from "./fxtweet";
import { chunkArray, itemsToMessageContents } from "../util";
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
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import config from "../../config/config";
import { IgStoriesSchema, type IgStories } from "./igStories";

dayjs.extend(utc);
dayjs.extend(timezone);

const KST_TIMEZONE = "Asia/Seoul";

const log = logger.child({ module: "snsHandler" });

const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export type Platform = "twitter" | "instagram" | "instagram-story";

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
  platform: "instagram" | "instagram-story";
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
  return (
    metadata.platform === "instagram" || metadata.platform === "instagram-story"
  );
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
  timestamp?: Date;
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

export function formatDiscordTitle(
  platform: Platform,
  username: string,
  date?: Date
): string {
  const djs = dayjs(date).tz(KST_TIMEZONE);

  let title = "`";
  if (date) {
    title += djs.format("YYMMDD");
    title += " ";
  }

  const platformName = platform[0].toUpperCase() + platform.slice(1);
  title += `${username} ${platformName} Update`;
  title += "`";

  return title;
}

export type ProgressFn = (message: string, done?: boolean) => Promise<void>;

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
    progressCallback?: ProgressFn
  ): Promise<PostData<M>[]>;

  abstract buildDiscordAttachments(
    postData: PostData<M>
  ): MessageCreateOptions[];

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
  ): Promise<PostData<TwitterMetadata>[]> {
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

    return [
      {
        postLink: snsLink,
        username: tweetRes.tweet.author.screen_name,
        postID: tweetRes.tweet.id,
        originalText: tweetRes.tweet.text,
        translatedText: tweetRes.tweet.translation?.text,
        translatedFromLang: tweetRes.tweet.translation?.source_lang_en,
        timestamp: new Date(tweetRes.tweet.created_timestamp * 1000),
        files,
      },
    ];
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<TwitterMetadata>
  ): MessageCreateOptions[] {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer).setName(
        `twitter-${postData.username}-${postData.postID}-${i + 1}.${file.ext}`
      )
    );

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
    postData: PostData<TwitterMetadata>,
    attachmentURLs: string[]
  ): MessageCreateOptions[] {
    let msgs: MessageCreateOptions[] = [];

    // Formatted post
    let mainPostContent = "";
    mainPostContent += formatDiscordTitle(
      "twitter",
      postData.username,
      postData.timestamp
    );
    mainPostContent += "\n";
    mainPostContent += `<https://x.com/${postData.username}/status/${postData.postID}>`;
    mainPostContent += "\n";

    // Image URLs can be span multiple messages
    const imageUrlsChunks = itemsToMessageContents(
      mainPostContent,
      attachmentURLs
    );

    const imageMsgs: MessageCreateOptions[] = imageUrlsChunks.map((chunk) => ({
      content: chunk,
      // Prevent embeds
      flags: MessageFlags.SuppressEmbeds,
    }));

    msgs.push(...imageMsgs);
    return msgs;
  }

  private origTwitterPhotoUrl(media: APIMedia): string {
    return `${media.url}?name=orig`;
  }
}

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

export class InstagramStoryDownloader extends SnsDownloader<InstagramMetadata> {
  URL_REGEX = new RegExp(
    /https?:\/\/(?:www\.)?instagram\.com\/([\w-]{3,})\//gi
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray
  ): SnsLink<InstagramMetadata> {
    return {
      url: match[0],
      metadata: {
        platform: "instagram-story",
      },
    };
  }

  buildApiRequest(details: SnsLink<InstagramMetadata>): Request {
    return new Request(
      `https://instagram-scraper-api2.p.rapidapi.com/v1/stories?username_or_id_or_url=${details.url}`,
      {
        method: "GET",
        headers: {
          "x-rapidapi-host": "instagram-scraper-api2.p.rapidapi.com",
          "x-rapidapi-key": config.RAPID_API_KEY,
        },
      }
    );
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
        "Failed to fetch ig API story response"
      );

      throw new Error("Failed to fetch ig API story response");
    }

    let rawJson;
    let igStoriesRes: IgStories;
    try {
      rawJson = await response.json();

      // Throws if invalid
      igStoriesRes = IgStoriesSchema.parse(rawJson);
    } catch (err) {
      log.error(
        {
          err,
          response,
          responseCode: response.status,
          body: rawJson,
        },
        "Failed to parse ig trigger API response"
      );

      throw new Error("Failed to parse ig JSON response");
    }

    log.debug(
      {
        igStoriesRes,
      },
      "Fetched IG stories response"
    );

    if (!igStoriesRes.data || !igStoriesRes.data.items) {
      throw new Error("No data");
    }

    if (igStoriesRes.data.items.length === 0) {
      throw new Error("No Instagram stories found");
    }

    progressCallback?.(
      `Downloading ${igStoriesRes.data.items.length} stories...`
    );

    // Categorize by date in KST!! Could be multiple stories on different days
    // YYMMDD -> [media URLs]
    const storiesByDate = new Map<string, { date?: Date; urls: string[] }>();

    for (const item of igStoriesRes.data.items) {
      let dateKey = "unknown";
      if (item.taken_at_date) {
        const d = dayjs(item.taken_at_date).tz(KST_TIMEZONE);
        dateKey = d.format("YYMMDD");
      } else {
        log.warn(
          {
            item,
          },
          "No taken_at_date ... bruh"
        );
      }

      // Default value
      const storiesDay = storiesByDate.get(dateKey) ?? {
        date: item.taken_at_date,
        urls: [],
      };

      // Video
      if (item.video_url) {
        storiesDay.urls.push(item.video_url);
      }

      // Otherwise thumbnail image. Video stories also have thumbnail images
      if (item.thumbnail_url) {
        storiesDay.urls.push(item.thumbnail_url);
      }

      // Need to set even if array is reference since object isn't set
      storiesByDate.set(dateKey, storiesDay);

      if (!item.video_url && !item.thumbnail_url) {
        log.warn(
          {
            item,
          },
          "No video or thumbnail URL... bruh"
        );
      }
    }

    log.debug(
      {
        stories: storiesByDate,
      },
      "Downloading media URLs"
    );

    const postDatas = [];
    for (const { date, urls } of storiesByDate.values()) {
      const buffers = await this.downloadImages(urls);

      const files = buffers.map((buf, i) => {
        return {
          ext: getFileExtFromURL(urls[i]),
          buffer: buf,
        };
      });

      const postData: PostData<InstagramMetadata> = {
        postLink: snsLink,
        username:
          igStoriesRes.data.additional_data?.user?.username || "Unknown user",
        postID: "",
        originalText: "",
        timestamp: date,
        files,
      };

      postDatas.push(postData);
    }

    progressCallback?.("Downloaded!", true);

    return postDatas;
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<InstagramMetadata>
  ): MessageCreateOptions[] {
    const ts = postData.timestamp
      ? dayjs(postData.timestamp).tz(KST_TIMEZONE).format("YYMMDD")
      : null;

    const attachments = postData.files.map((file, i) => {
      let name;
      if (ts) {
        // Has timestamp
        name = `ig-story-${postData.username}-${ts}-${i + 1}.${file.ext}`;
      } else {
        // No timestamp, exclude
        name = `ig-story-${postData.username}-${i + 1}.${file.ext}`;
      }

      return new AttachmentBuilder(file.buffer).setName(name);
    });

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
