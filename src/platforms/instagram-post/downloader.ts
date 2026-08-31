import { sleep } from "bun";
import { ApiUsageEndpoint, recordApiUsage } from "../../apiUsage";
import {
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import logger from "../../logger";
import { chunkArray, formatDiscordTitle, itemsToMessageContents, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import { tryWithFallbacks } from "../../utils/fallback";
import { getFileExtFromURL, tracedFetch } from "../../utils/http";
import { convertHeicToJpeg } from "../../utils/heic";
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
import {
  BdMonitorResponseSchema,
  BdTriggerResponseSchema,
  BestExperiencePostSchema,
  type BdMonitorResponse,
  type BdTriggerResponse,
  InstagramPostListSchema,
  type InstagramPostElement,
} from "./types";

const log = logger.child({ module: "InstagramPostDownloader" });

export class InstagramPostDownloader extends SnsDownloader<InstagramMetadata> {
  PLATFORM: Platform = "instagram";

  URL_REGEX = new RegExp(
    /https?:\/\/(?:www\.)?instagram\.com\/(?:([\w.]+)\/reels?\/|(?:p|reels?|tv)\/)([\w-]+)\/?/gi,
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray,
  ): SnsLink<InstagramMetadata> {
    return {
      url: match[0],
      metadata: {
        platform: "instagram",
        shortcode: match[2],
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
          Authorization: `Bearer ${process.env.BD_API_TOKEN!}`,
        },
        body: JSON.stringify([{ url: details.url }]),
      },
    );
  }

  async waitUntilDataReady(snapshotID: string, timeoutMs = 30_000): Promise<void> {
    const req = new Request(
      `https://api.brightdata.com/datasets/v3/progress/${snapshotID}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.BD_API_TOKEN!}`,
        },
      },
    );

    let cancelAt = Date.now() + timeoutMs;

    let resParsed: BdMonitorResponse;
    while (true) {
      const res = await tracedFetch(req);
      recordApiUsage(ApiUsageEndpoint.BRIGHTDATA_PROGRESS);

      // Might be too fast, retry at least 5 times
      if (res.status === 404) {
        if (Date.now() > cancelAt) {
          log.error(
            {
              requestURL: res.url,
              responseCode: res.status,
              responseBody: await res.text(),
            },
            "Failed to fetch ig API snapshot response",
          );

          throw new Error("Failed to fetch Instagram post (timed out)");
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
          "Failed to fetch ig API snapshot response",
        );

        throw new Error(`Failed to fetch Instagram post (${res.status})`);
      }

      const resJson = await res.json();

      resParsed = BdMonitorResponseSchema.parse(resJson);
      if (resParsed.status === "failed") {
        log.error(
          {
            resParsed,
          },
          "IG API failed to process the post",
        );

        throw new Error("Failed to fetch Instagram post");
      }

      // Done, break loop
      if (resParsed.status === "ready") {
        break;
      }

      // Still processing ("starting" / "running") — wait before retrying
      if (Date.now() > cancelAt) {
        throw new Error("Failed to fetch Instagram post (timed out)");
      }

      await sleep(1000);
    }
  }

  async fetchAllSnapshotData(snapshotID: string): Promise<InstagramPostElement[]> {
    // 5 retries
    for (let i = 0; i < 5; i++) {
      const req = new Request(
        `https://api.brightdata.com/datasets/v3/snapshot/${snapshotID}?format=json`,
        {
          headers: {
            Authorization: `Bearer ${process.env.BD_API_TOKEN!}`,
          },
        },
      );

      const response = await tracedFetch(req);
      recordApiUsage(ApiUsageEndpoint.BRIGHTDATA_SNAPSHOT);

      // Might be too fast, "Snapshot is building, try again in 30s"
      if (response.status === 202) {
        log.debug(
          {
            requestURL: req.url,
            responseCode: response.status,
            responseBody: await response.text(),
          },
          "IG API snapshot is still building",
        );

        // Retry in 3 seconds
        await sleep(3 * 1000);
        continue;
      }

      if (response.status !== 200) {
        log.error(
          {
            responseCode: response.status,
            responseBody: await response.text(),
          },
          "Failed to fetch ig API snapshot response",
        );

        await sleep(3 * 1000);
        continue;
      }

      try {
        const rawJson = await response.json();
        return InstagramPostListSchema.parse(rawJson);
      } catch (err) {
        log.error(
          {
            err,
            response,
            responseCode: response.status,
          },
          "Failed to parse ig API snapshot response",
        );

        throw err;
      }
    }

    throw new Error("Failed to fetch Instagram post");
  }

  async fetchSnapshotData(snapshotID: string): Promise<InstagramPostElement> {
    const posts = await this.fetchAllSnapshotData(snapshotID);
    if (posts.length === 0) {
      throw new Error("No Instagram posts found");
    }
    return posts[0];
  }

  // ---------------------------------------------------------------------------
  // RapidAPI provider: instagram-best-experience GET /post?shortcode=
  // ---------------------------------------------------------------------------

  private async fetchContentViaBestExperience(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    const shortcode = snsLink.metadata.shortcode;
    if (!shortcode) {
      throw new Error("No shortcode available for RapidAPI fetch");
    }

    const req = new Request(
      `https://instagram-best-experience.p.rapidapi.com/post?shortcode=${shortcode}`,
      {
        method: "GET",
        headers: {
          "x-rapidapi-host": "instagram-best-experience.p.rapidapi.com",
          "x-rapidapi-key": process.env.RAPID_API_KEY!,
        },
      },
    );

    progressCallback?.("Fetching post...");

    const response = await tracedFetch(req);
    recordApiUsage(ApiUsageEndpoint.RAPIDAPI_IG_BEST_EXPERIENCE_POST);
    if (!response.ok) {
      throw new Error("Failed to fetch Instagram post.");
    }

    const rawJson = await response.json();
    const post = BestExperiencePostSchema.parse(rawJson);

    const extractMediaUrl = (item: {
      video_versions?: { url: string }[];
      image_versions2?: { candidates?: { url: string }[] };
    }): string | undefined =>
      item.video_versions?.[0]?.url ?? item.image_versions2?.candidates?.[0]?.url;

    const mediaUrls = post.carousel_media?.length
      ? post.carousel_media
          .map(extractMediaUrl)
          .filter((u): u is string => !!u)
      : [extractMediaUrl(post)].filter((u): u is string => !!u);

    if (mediaUrls.length === 0) {
      throw new Error("No media found for this Instagram post");
    }

    progressCallback?.("Downloading images...");
    const buffers = await this.downloadImages(mediaUrls);
    let files = buffers.map((buf, i): File => ({
      ext: getFileExtFromURL(mediaUrls[i]),
      buffer: buf,
    }));
    files = await convertHeicToJpeg(files);

    progressCallback?.("Downloaded!", true);

    return [
      {
        postLink: {
          ...snsLink,
          url: post.code
            ? `https://www.instagram.com/p/${post.code}/`
            : snsLink.url,
        },
        username: post.user?.username || "Unknown user",
        postID: post.code || shortcode,
        originalText: post.caption?.text || "",
        timestamp: post.taken_at ? new Date(post.taken_at * 1000) : undefined,
        files,
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // RapidAPI provider: instagram-looter2 GET /post?link=
  // ---------------------------------------------------------------------------

  private async fetchContentViaLooter(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    const req = new Request(
      `https://instagram-looter2.p.rapidapi.com/post?link=${encodeURIComponent(snsLink.url)}`,
      {
        method: "GET",
        headers: {
          "x-rapidapi-host": "instagram-looter2.p.rapidapi.com",
          "x-rapidapi-key": process.env.RAPID_API_KEY!,
        },
      },
    );

    progressCallback?.("Fetching post...");

    const response = await tracedFetch(req);
    recordApiUsage(ApiUsageEndpoint.RAPIDAPI_IG_LOOTER_POST);
    if (!response.ok) {
      throw new Error("Failed to fetch Instagram post.");
    }

    // Looter returns Instagram's raw GraphQL post shape — duck-typed, no zod schema.
    const post: any = await response.json();
    if (post?.status === false) {
      throw new Error("Failed to fetch Instagram post.");
    }

    const shortcode: string | undefined = post.shortcode ?? snsLink.metadata.shortcode;

    const extractMediaUrl = (node: any): string | undefined =>
      node?.video_url ?? node?.display_url;

    const children = post.edge_sidecar_to_children?.edges;
    const mediaUrls: string[] = Array.isArray(children) && children.length > 0
      ? children
          .map((edge: any) => extractMediaUrl(edge?.node))
          .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
      : [extractMediaUrl(post)].filter((u): u is string => !!u);

    if (mediaUrls.length === 0) {
      throw new Error("No media found for this Instagram post");
    }

    progressCallback?.("Downloading images...");
    const buffers = await this.downloadImages(mediaUrls);
    let files = buffers.map((buf, i): File => ({
      ext: getFileExtFromURL(mediaUrls[i]),
      buffer: buf,
    }));
    files = await convertHeicToJpeg(files);

    progressCallback?.("Downloaded!", true);

    const caption = post.edge_media_to_caption?.edges?.[0]?.node?.text ?? "";

    return [
      {
        postLink: {
          ...snsLink,
          url: shortcode ? `https://www.instagram.com/p/${shortcode}/` : snsLink.url,
        },
        username: post.owner?.username || "Unknown user",
        postID: shortcode || "Unknown ID",
        originalText: caption,
        timestamp: post.taken_at_timestamp
          ? new Date(post.taken_at_timestamp * 1000)
          : undefined,
        files,
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Brightdata provider (existing trigger/poll/snapshot)
  // ---------------------------------------------------------------------------

  private async fetchContentViaBrightdata(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    const req = this.buildApiRequest(snsLink);
    const response = await tracedFetch(req);
    recordApiUsage(ApiUsageEndpoint.BRIGHTDATA_TRIGGER);

    if (response.status !== 200) {
      log.error(
        {
          request: req.headers,
          responseCode: response.status,
          responseBody: await response.text(),
        },
        "Failed to fetch ig API response",
      );

      throw new Error("Failed to fetch Instagram post");
    }

    let triggerResponse: BdTriggerResponse;
    try {
      const rawJson = await response.json();
      triggerResponse = BdTriggerResponseSchema.parse(rawJson);
    } catch (err) {
      log.error(
        {
          err,
          response,
          responseCode: response.status,
        },
        "Failed to parse ig trigger API response",
      );

      throw new Error("Failed to process Instagram post");
    }

    if (!triggerResponse.snapshot_id) {
      throw new Error("Instagram snapshot ID not found");
    }

    progressCallback?.("Waiting for IG data...");
    log.debug(
      { snapshotID: triggerResponse.snapshot_id },
      "Waiting for IG API to process the post",
    );
    await this.waitUntilDataReady(triggerResponse.snapshot_id);

    log.debug(
      { snapshotID: triggerResponse.snapshot_id },
      "IG API processed the post, downloading data...",
    );

    progressCallback?.("Downloading images...");

    const igPost = await this.fetchSnapshotData(triggerResponse.snapshot_id);

    if (!igPost.post_content || igPost.post_content.length === 0) {
      throw new Error("No Instagram post content found");
    }

    const mediaUrls = igPost.post_content
      .map((m) => m.url)
      .filter((x): x is string => !!x);

    const buffers = await this.downloadImages(mediaUrls);
    let files = buffers.map((buf, i): File => ({
      ext: getFileExtFromURL(mediaUrls[i]),
      buffer: buf,
    }));
    files = await convertHeicToJpeg(files);

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

  // ---------------------------------------------------------------------------
  // Public fetchContent — tries providers with fallbacks
  // ---------------------------------------------------------------------------

  async fetchContent(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    return tryWithFallbacks([
      {
        name: "RapidAPI instagram-best-experience",
        fn: () => this.fetchContentViaBestExperience(snsLink, progressCallback),
      },
      {
        name: "RapidAPI instagram-looter2",
        fn: () => this.fetchContentViaLooter(snsLink, progressCallback),
      },
      {
        name: "Brightdata",
        fn: () => this.fetchContentViaBrightdata(snsLink, progressCallback),
      },
    ]);
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<InstagramMetadata>,
  ): MessageCreateOptions[] {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer).setName(
        `ig-${postData.username}-${postData.postID}-${i + 1}.${file.ext}`,
      ),
    );

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
