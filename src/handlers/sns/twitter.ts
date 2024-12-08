import {
  Attachment,
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import type { APIMedia, TweetAPIResponse } from "./fxtweet";
import { itemsToMessageContents } from "../util";
import logger from "../../logger";

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
  username: string;
  id: string;
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

// Actual details and files of a post
export interface PostData<M extends SnsMetadata> {
  postLink: SnsLink<M>;
  username: string;
  postID: string;
  originalText: string;
  translatedText?: string;
  translatedFromLang?: string;
  content: string;
  files: Buffer[];
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

    return results;
  }

  /**
   * Abstract method to create a post object from regex match
   * @param match Regex match result
   * @returns Platform-specific post object
   */
  protected abstract createLinkFromMatch(match: RegExpMatchArray): SnsLink<M>;

  /**
   * Build API URL using the extracted details.
   */
  abstract buildApiUrl(details: SnsLink<M>): string;

  /**
   * Fetch content from the platform's API
   */
  abstract fetchContent(snsLink: SnsLink<M>): Promise<PostData<M>>;

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

  buildApiUrl(details: SnsLink<TwitterMetadata>): string {
    return `https://api.fxtwitter.com/${details.metadata.username}/status/${details.metadata.id}/en`;
  }

  async fetchContent(
    snsLink: SnsLink<TwitterMetadata>
  ): Promise<PostData<TwitterMetadata>> {
    const apiURL = this.buildApiUrl(snsLink);
    const response = await fetchWithHeaders(apiURL);

    let tweetRes: TweetAPIResponse;
    try {
      tweetRes = await response.json();
    } catch (err) {
      log.error(
        {
          err,
          apiURL,
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

    const files = await this.downloadImages(media?.map((m) => m.url) ?? []);

    return {
      postLink: snsLink,
      username: tweetRes.tweet.author.screen_name,
      postID: tweetRes.tweet.id,
      originalText: tweetRes.tweet.text,
      translatedText: tweetRes.tweet.translation?.text,
      translatedFromLang: tweetRes.tweet.translation?.source_lang_en,
      content: tweetRes.tweet.text,
      files,
    };
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<TwitterMetadata>
  ): MessageCreateOptions {
    const attachments = postData.files.map((image, i) =>
      new AttachmentBuilder(image)
        .setName(`twitter-${postData.username}-${postData.postID}-${i}.jpg`)
        .setDescription(`${postData.username} - ${postData.postID} - ${i}`)
    );

    return {
      content: "PLS DON'T DELETE ME 😭🙏!! or it will break the image links",
      files: attachments,
    };
  }

  buildDiscordMessages(
    postData: PostData<TwitterMetadata>,
    attachmentURLs: string[]
  ): MessageCreateOptions[] {
    let msgs: MessageCreateOptions[] = [];

    let textContent;
    if (postData.translatedText) {
      textContent = postData.translatedText;
    } else {
      textContent = postData.originalText;
    }

    textContent += "\n\n";
    textContent += `<https://x.com/${postData.username}/status/${postData.postID}>`;
    textContent += "\n";

    // Translated or original text
    msgs.push({
      content: textContent,
      flags: MessageFlags.SuppressEmbeds,
    });

    // Image URLs can be span multiple messages
    const imageUrlsChunks = itemsToMessageContents(attachmentURLs);
    for (const chunk of imageUrlsChunks) {
      msgs.push({
        content: chunk,
        // Prevent embeds
        flags: MessageFlags.SuppressEmbeds,
      });
    }

    return msgs;
  }

  private origTwitterPhotoUrl(media: APIMedia): string {
    return `${media.url}?name=orig`;
  }
}
