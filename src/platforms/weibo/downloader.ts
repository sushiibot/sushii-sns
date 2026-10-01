import {
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import { ApiUsageEndpoint } from "../../apiUsage";
import {
  chunkArray,
  formatDiscordTitle,
  itemsToMessageContents,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../utils/discord";
import { tryWithFallbacks } from "../../utils/fallback";
import { buildLinksFormatMessages } from "../../utils/template";
import { downloadMedia, tikhubGet } from "../../utils/tikhub";
import {
  SnsDownloader,
  type Platform,
  type PostData,
  type ProgressFn,
  type SnsLink,
  type WeiboMetadata,
} from "../base";
import { bidToMid, parseWeiboPost, type WeiboPost } from "./parse";

// sinaimg.cn / weibocdn 403s hotlinks without a weibo Referer
const WEIBO_REFERER = "https://weibo.com/";

export class WeiboDownloader extends SnsDownloader<WeiboMetadata> {
  PLATFORM: Platform = "weibo";

  // - https://weibo.com/{uid}/{bid or mid}
  // - https://m.weibo.cn/detail/{mid}, https://m.weibo.cn/status/{bid or mid}
  // - https://weibo.com/detail/{mid}
  // IDs are a 16+ digit mid or an 8-10 char base62 bid, which keeps profile
  // paths like weibo.com/u/123 and weibo.com/123/profile from matching.
  URL_REGEX = new RegExp(
    /https?:\/\/(?:www\.|m\.)?weibo\.(?:com|cn)\/(?:detail|status|\d+)\/(?<id>\d{16,}|[A-Za-z0-9]{8,10})(?![A-Za-z0-9])(?:\?[^\s<>]*)?/gi,
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray,
  ): SnsLink<WeiboMetadata> {
    const id = match.groups?.id;
    if (!id) {
      throw new Error("No Weibo post ID match found");
    }

    return {
      url: match[0],
      metadata: {
        platform: "weibo",
        mid: /^\d+$/.test(id) ? id : bidToMid(id),
      },
    };
  }

  buildApiRequest(): Request {
    throw new Error("Weibo uses tikhubGet with endpoint fallbacks");
  }

  private fetchPost(snsLink: SnsLink<WeiboMetadata>): Promise<WeiboPost> {
    const { mid } = snsLink.metadata;

    return tryWithFallbacks([
      {
        name: "tikhub weibo web_v2",
        fn: async () =>
          parseWeiboPost(
            await tikhubGet(
              "/api/v1/weibo/web_v2/fetch_post_detail",
              { id: mid, is_get_long_text: "true" },
              ApiUsageEndpoint.TIKHUB_WEIBO_WEB_V2_POST_DETAIL,
            ),
            mid,
          ),
      },
      {
        name: "tikhub weibo app",
        fn: async () =>
          parseWeiboPost(
            await tikhubGet(
              "/api/v1/weibo/app/fetch_status_detail",
              { status_id: mid },
              ApiUsageEndpoint.TIKHUB_WEIBO_APP_STATUS_DETAIL,
            ),
            mid,
          ),
      },
    ]);
  }

  async fetchContent(
    snsLink: SnsLink<WeiboMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<WeiboMetadata>[]> {
    const post = await this.fetchPost(snsLink);

    if (post.media.length > 0) {
      progressCallback?.(`Downloading ${post.media.length} weibo media...`);
    }

    const files = await Promise.all(
      post.media.map((m) =>
        downloadMedia(m.url, m.kind === "video" ? "mp4" : "jpg", WEIBO_REFERER),
      ),
    );

    progressCallback?.("Downloaded!", true);

    return [
      {
        postLink: snsLink,
        username: post.username,
        postID: post.postId,
        originalText: post.text,
        timestamp: post.timestamp,
        files,
      },
    ];
  }

  buildDiscordAttachments(
    postData: PostData<WeiboMetadata>,
  ): MessageCreateOptions[] {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer).setName(
        `weibo-${postData.postID}-${i + 1}.${file.ext}`,
      ),
    );

    return chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE).map(
      (chunk) => ({
        content: "",
        files: chunk,
      }),
    );
  }

  buildDiscordMessages(
    postData: PostData<WeiboMetadata>,
    attachmentURLs: string[],
    template?: string,
  ): MessageCreateOptions[] {
    if (template) {
      return buildLinksFormatMessages(template, postData, attachmentURLs);
    }

    let mainPostContent = formatDiscordTitle(
      "weibo",
      postData.username,
      postData.timestamp,
    );
    mainPostContent += `\n<${postData.postLink.url}>\n`;

    if (postData.originalText.trim()) {
      mainPostContent += `\n${postData.originalText.trim()}\n`;
    }

    return itemsToMessageContents(mainPostContent, attachmentURLs).map(
      (chunk) => ({
        content: chunk,
        flags: MessageFlags.SuppressEmbeds,
      }),
    );
  }
}
