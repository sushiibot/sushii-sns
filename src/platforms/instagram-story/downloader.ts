import dayjs from "dayjs";
import {
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import logger from "../../logger";
import { chunkArray, formatDiscordTitle, itemsToMessageContents, KST_TIMEZONE, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import { getFileExtFromURL, parseJsonPreservingBigIntKeys, tracedFetch } from "../../utils/http";
import { convertHeicToJpeg } from "../../utils/heic";
import { ApiUsageEndpoint, recordApiUsage } from "../../apiUsage";
import { tryWithFallbacks } from "../../utils/fallback";
import { StoryUnavailableError } from "./errors";
import { buildLinksFormatMessages } from "../../utils/template";
import {
  SnsDownloader,
  type File,
  type InstagramMetadata,
  type Platform,
  type PostData,
  type ProgressFn,
  type SnsLink,
} from "../base";
import { resolveInstagramUserId } from "../../utils/instagramBestExperience";
import {
  BestExperienceStoriesSchema,
  getStoryItemPk,
  type StoryItem,
} from "./types";

const log = logger.child({ module: "InstagramStoryDownloader" });

export class InstagramStoryDownloader extends SnsDownloader<InstagramMetadata> {
  PLATFORM: Platform = "instagram-story";

  URL_REGEX = new RegExp(
    "https?://" +
    "(?:www\\.)?" +
    "instagram\\.com/" +
    "(?:" +
      // Specific story URL: /stories/USER/ID/
      "stories/([\\w.-]+)/(\\d+)/?" +
      "|" +
      // Profile URL: /USERNAME/ (excludes known path segments)
      "((?!(?:p|reel|reels|tv|stories)/)\\w[\\w.-]{2,})/" +
    ")" +
    "(?:\\?[^\\s]*)?" +
    "(?:#[^\\s]*)?",
    "gi"
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray,
  ): SnsLink<InstagramMetadata> {
    if (match[1] && match[2]) {
      // Specific story URL: /stories/USER/ID/
      return {
        url: match[0],
        metadata: {
          platform: "instagram-story",
          username: match[1],
          shortcode: match[2],
        },
      };
    }

    // Profile URL: /USERNAME/
    return {
      url: match[0],
      metadata: {
        platform: "instagram-story",
        username: match[3],
      },
    };
  }

  buildApiRequest(details: SnsLink<InstagramMetadata>): Request {
    return new Request(
      `https://instagram-best-experience.p.rapidapi.com/profile?username=${details.metadata.username}`,
      {
        method: "GET",
        headers: {
          "x-rapidapi-host": "instagram-best-experience.p.rapidapi.com",
          "x-rapidapi-key": process.env.RAPID_API_KEY!,
        },
      },
    );
  }

  private async resolveUserId(username: string): Promise<string> {
    try {
      return await resolveInstagramUserId(username, process.env.RAPID_API_KEY!);
    } catch (err) {
      log.error({ err, username }, "Failed to resolve Instagram username to user ID");
      throw new StoryUnavailableError("Could not find that Instagram profile.");
    }
  }

  private async fetchStoriesForUserId(userId: string): Promise<StoryItem[]> {
    const req = new Request(
      `https://instagram-best-experience.p.rapidapi.com/stories?user_id=${userId}`,
      {
        method: "GET",
        headers: {
          "x-rapidapi-host": "instagram-best-experience.p.rapidapi.com",
          "x-rapidapi-key": process.env.RAPID_API_KEY!,
        },
      },
    );

    const response = await tracedFetch(req);
    recordApiUsage(ApiUsageEndpoint.RAPIDAPI_IG_BEST_EXPERIENCE_STORIES);

    if (!response.ok) {
      const body = await response.text();
      log.error(
        { responseCode: response.status, responseBody: body },
        "Failed to fetch ig best-experience stories response",
      );
      throw new Error(`Failed to fetch Instagram stories (${response.status})`);
    }

    const rawJson = parseJsonPreservingBigIntKeys(await response.text(), ["pk", "id"]);
    return BestExperienceStoriesSchema.parse(rawJson);
  }

  private async fetchContentViaRapidApi(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    const username = snsLink.metadata.username!;
    const storyId = snsLink.metadata.shortcode!;

    const userId = await this.resolveUserId(username);
    let allItems: StoryItem[];
    try {
      allItems = await this.fetchStoriesForUserId(userId);
    } catch (err) {
      throw new StoryUnavailableError(
        "This Instagram story is no longer available. Stories expire after about 24 hours, or the link may be invalid.",
      );
    }
    const items = allItems.filter((item) => getStoryItemPk(item) === storyId);

    if (items.length === 0) {
      throw new StoryUnavailableError(
        "No story found at that link. Instagram stories expire after about 24 hours.",
      );
    }

    progressCallback?.(`Downloading ${items.length} story`);

    // Categorize by date in KST!! Could be multiple stories on different days
    // YYMMDD -> [media URLs]
    const storiesByDate = new Map<string, { date?: Date; urls: string[] }>();

    for (const item of items) {
      const takenAtMs = item.taken_at * 1000;
      const d = dayjs(takenAtMs).tz(KST_TIMEZONE);
      const dateKey = d.format("YYMMDD");

      const storiesDay = storiesByDate.get(dateKey) ?? {
        date: new Date(takenAtMs),
        urls: [],
      };

      let mediaUrl: string | undefined;

      if (item.video_versions?.[0]?.url) {
        mediaUrl = item.video_versions[0].url;
      } else if (item.video_url) {
        mediaUrl = item.video_url;
      } else if (item.image_versions2?.candidates?.[0]?.url) {
        mediaUrl = item.image_versions2.candidates[0].url;
      } else if (item.thumbnail_url) {
        mediaUrl = item.thumbnail_url;
      }

      if (mediaUrl) {
        storiesDay.urls.push(mediaUrl);
      } else {
        log.warn({ item, pk: item.pk }, "No extractable media URL for story");
      }

      storiesByDate.set(dateKey, storiesDay);
    }

    const storyUsername = items[0]?.user?.username || username;
    const postDatas: PostData<InstagramMetadata>[] = [];
    for (const [dateKey, { date, urls }] of storiesByDate.entries()) {
      const buffers = await this.downloadImages(urls);

      let files: File[] = buffers.map((buf, i) => {
        return {
          ext: getFileExtFromURL(urls[i]),
          buffer: buf,
        };
      });

      // Convert any HEIC files to JPEG
      files = await convertHeicToJpeg(files);

      const postData: PostData<InstagramMetadata> = {
        postLink: snsLink,
        username: storyUsername,
        postID: `instagram-story:${storyUsername}:${dateKey}`,
        originalText: "",
        timestamp: date,
        files,
      };

      postDatas.push(postData);
    }

    progressCallback?.("Downloaded!", true);

    return postDatas;
  }

  private async fetchContentViaStoriesFeedApi(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    const username = snsLink.metadata.username!;

    const userId = await this.resolveUserId(username);
    let items: StoryItem[];
    try {
      items = await this.fetchStoriesForUserId(userId);
    } catch (err) {
      throw new StoryUnavailableError(
        "Could not fetch stories for that profile. The account may be private or have no active stories.",
      );
    }

    if (items.length === 0) {
      throw new StoryUnavailableError(
        "No active stories found for that profile.",
      );
    }

    progressCallback?.(`Downloading ${items.length} stories`);

    const storiesByDate = new Map<string, { date?: Date; urls: string[] }>();

    for (const item of items) {
      const takenAtMs = (item.taken_at ?? 0) * 1000;
      const d = dayjs(takenAtMs).tz(KST_TIMEZONE);
      const dateKey = takenAtMs ? d.format("YYMMDD") : "unknown";

      const storiesDay = storiesByDate.get(dateKey) ?? {
        date: takenAtMs ? new Date(takenAtMs) : undefined,
        urls: [],
      };

      let mediaUrl: string | undefined;

      if (item.video_versions?.[0]?.url) {
        mediaUrl = item.video_versions[0].url;
      } else if (item.video_url) {
        mediaUrl = item.video_url;
      } else if (item.image_versions2?.candidates?.[0]?.url) {
        mediaUrl = item.image_versions2.candidates[0].url;
      } else if (item.thumbnail_url) {
        mediaUrl = item.thumbnail_url;
      }

      if (mediaUrl) {
        storiesDay.urls.push(mediaUrl);
      } else {
        log.warn({ item }, "No extractable media URL for story feed item");
      }

      storiesByDate.set(dateKey, storiesDay);
    }

    const postDatas: PostData<InstagramMetadata>[] = [];
    for (const [dateKey, { date, urls }] of storiesByDate.entries()) {
      const buffers = await this.downloadImages(urls);

      let files: File[] = buffers.map((buf, i) => ({
        ext: getFileExtFromURL(urls[i]),
        buffer: buf,
      }));

      files = await convertHeicToJpeg(files);

      postDatas.push({
        postLink: snsLink,
        username,
        postID: `instagram-story:${username}:${dateKey}`,
        originalText: "",
        timestamp: date,
        files,
      });
    }

    progressCallback?.("Downloaded!", true);
    return postDatas;
  }

  // ---------------------------------------------------------------------------
  // Public fetchContent — tries providers with fallbacks
  // ---------------------------------------------------------------------------

  async fetchContent(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    if (!snsLink.metadata.shortcode) {
      // Profile URL — fetch all current stories for this user
      return tryWithFallbacks([
        {
          name: "RapidAPI stories feed",
          fn: () => this.fetchContentViaStoriesFeedApi(snsLink, progressCallback),
        },
      ]);
    }

    return tryWithFallbacks([
      {
        name: "RapidAPI stories",
        fn: () => this.fetchContentViaRapidApi(snsLink, progressCallback),
      },
      // TODO: Add additional fallback provider here
      // { name: "Placeholder", fn: () => ... },
    ]);
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<InstagramMetadata>,
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
      MAX_ATTACHMENTS_PER_MESSAGE,
    );

    return attachmentsChunks.map((chunk) => {
      return {
        content: "",
        files: chunk,
      };
    });
  }

  buildDiscordMessages(
    postData: PostData<InstagramMetadata>,
    attachmentURLs: string[],
    template?: string,
  ): MessageCreateOptions[] {
    if (template) {
      return buildLinksFormatMessages(template, postData, attachmentURLs);
    }

    let msgs: MessageCreateOptions[] = [];

    let mainPostContent = "";
    mainPostContent += formatDiscordTitle(
      "instagram",
      postData.username,
      postData.timestamp,
    );
    mainPostContent += "\n";
    mainPostContent += `<${postData.postLink.url}>`;
    mainPostContent += "\n";

    // Image URLs can be span multiple messages
    const msgChunkContents = itemsToMessageContents(
      mainPostContent,
      attachmentURLs,
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
