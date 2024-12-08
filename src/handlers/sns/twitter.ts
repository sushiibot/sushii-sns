import {
  Attachment,
  AttachmentBuilder,
  type MessageCreateOptions,
} from "discord.js";
import type { APIMedia, TweetAPIResponse } from "./fxtweet";

export type SnsPost<PostMetaData> = {
  url: string;
  metadata: PostMetaData;
};

export type TwitterMetadata = {
  username: string;
  id: string;
};

export type PostData = {
  username: string;
  postID: string;
  originalText: string;
  translatedText?: string;
  translatedFromLang?: string;
  content: string;
  files: Buffer[];
};

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

abstract class SnsDownloader<SnsDetail> {
  /**
   * Extract URLs from the given text.
   */
  abstract findUrls(content: string): SnsDetail[];

  /**
   * Build API URL using the extracted details.
   */
  abstract buildApiUrl(details: SnsDetail): string;

  /**
   * Fetch content from the platform's API
   */
  abstract fetchContent(apiUrl: string): Promise<PostData>;

  /**
   * Build a Discord message using the fetched content and images.
   */
  abstract buildDiscordMessage(
    postData: PostData,
    attachmentURLs: string[]
  ): MessageCreateOptions;

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

export class TwitterDownloader extends SnsDownloader<SnsPost<TwitterMetadata>> {
  RE_TWITTER = new RegExp(
    "https?://(?:(?:www|m|mobile)\\.)?" +
      "(?:twitter\\.com|x\\.com)" +
      "/(\\w+)/status/(\\d+)(/(?:photo|video)/\\d)?/?(?:\\?\\S+)?(?:#\\S+)?",
    // 'i' flag for case-insensitivity
    // 'g' flag for global search - makes String.match() exclude capture groups
    "ig"
  );

  findUrls(content: string): SnsPost<TwitterMetadata>[] {
    const matches = content.matchAll(this.RE_TWITTER) ?? [];

    const results = [];

    for (const match of matches) {
      results.push({
        url: match[0],
        metadata: {
          username: match[1],
          id: match[2],
        },
      });
    }

    return results;
  }

  buildApiUrl(details: SnsPost<TwitterMetadata>): string {
    return `https://api.fxtwitter.com/${details.metadata.username}/status/${details.metadata.id}/en`;
  }

  async fetchContent(apiUrl: string): Promise<PostData> {
    const response = await fetchWithHeaders(apiUrl);
    const tweetRes: TweetAPIResponse = await response.json();

    if (tweetRes.code !== 200) {
      throw new Error("Failed to fetch tweet: " + tweetRes.message);
    }

    if (!tweetRes.tweet) {
      throw new Error("Tweet not found: " + tweetRes.message);
    }

    const media = tweetRes.tweet.media.all?.map((m) => ({
      ...m,
      url: origPhotoUrl(m),
    }));

    const files = await this.downloadImages(media?.map((m) => m.url) ?? []);

    return {
      username: tweetRes.tweet.author.screen_name,
      postID: tweetRes.tweet.id,
      originalText: tweetRes.tweet.text,
      translatedText: tweetRes.tweet.translation?.text,
      translatedFromLang: tweetRes.tweet.translation?.source_lang_en,
      content: tweetRes.tweet.text,
      files,
    };
  }

  buildDiscordAttachments(postData: PostData): MessageCreateOptions {
    const attachments = postData.files.map((image, i) =>
      new AttachmentBuilder(image)
        .setName(`twitter-${postData.username}-${postData.postID}-${i}.jpg`)
        .setDescription(`${postData.username} - ${postData.postID} - ${i}`)
    );

    return {
      content:
        "PLS DON'T DELETE ME 😭🙏‼️ " +
        "This msg got the IMAGES LINKED below ⬇️ " +
        "and might get YOINKED for other places 🤔👀",
      files: attachments,
    };
  }

  buildDiscordMessage(
    postData: PostData,
    attachmentURLs: string[]
  ): MessageCreateOptions {
    let content = "";
    content += "### Original\n";
    content += "```\n";
    content += postData.originalText;
    content += "\n```";

    if (postData.translatedText) {
      content += "\n";

      if (postData.translatedFromLang) {
        content += `### Translated from: ${postData.translatedFromLang}\n`;
      } else {
        content += "### Translated\n";
      }

      content += "```\n";
      content += postData.translatedText;
      content += "\n```";
    }

    if (attachmentURLs.length > 0) {
      content += "\n";
      content += "### Images\n";
      content += "```\n";
      content += attachmentURLs.join("\n");
      content += "\n```";
    }

    return {
      content: content,
    };
  }
}

function origPhotoUrl(media: APIMedia): string {
  return `${media.url}?name=orig`;
}
