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
  type File,
  type Platform,
  type PostData,
  type ProgressFn,
  type SnsLink,
  type XiaohongshuMetadata,
} from "../base";
import { parseXhsNote, type XhsNote } from "./parse";

const XHS_REFERER = "https://www.xiaohongshu.com/";

// Tried in order. Both accept either note_id or a share link.
const NOTE_ENDPOINTS = [
  {
    path: "/api/v1/xiaohongshu/app/get_note_info",
    usage: ApiUsageEndpoint.TIKHUB_XHS_APP_NOTE_INFO,
  },
  {
    path: "/api/v1/xiaohongshu/web/get_note_info_v7",
    usage: ApiUsageEndpoint.TIKHUB_XHS_WEB_NOTE_INFO_V7,
  },
];

export class XiaohongshuDownloader extends SnsDownloader<XiaohongshuMetadata> {
  PLATFORM: Platform = "xiaohongshu";

  // - https://www.xiaohongshu.com/explore/{noteId}?xsec_token=...
  // - https://www.xiaohongshu.com/discovery/item/{noteId}
  // - https://www.xiaohongshu.com/user/profile/{userId}/{noteId}
  // - http://xhslink.com/a/{code} (app share short link)
  URL_REGEX = new RegExp(
    /https?:\/\/(?:(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item|user\/profile\/[0-9a-f]+)\/(?<noteId>[0-9a-f]{24})(?:\?[^\s<>]*)?|xhslink\.com\/(?:[A-Za-z0-9]+\/)*[A-Za-z0-9]+)/gi,
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray,
  ): SnsLink<XiaohongshuMetadata> {
    return {
      url: match[0],
      metadata: {
        platform: "xiaohongshu",
        noteId: match.groups?.noteId?.toLowerCase(),
      },
    };
  }

  buildApiRequest(): Request {
    throw new Error("Xiaohongshu uses tikhubGet with endpoint fallbacks");
  }

  private fetchNote(snsLink: SnsLink<XiaohongshuMetadata>): Promise<XhsNote> {
    const { noteId } = snsLink.metadata;

    return tryWithFallbacks(
      NOTE_ENDPOINTS.map((endpoint) => ({
        name: endpoint.path,
        fn: async () => {
          const data = await tikhubGet(
            endpoint.path,
            // Short links have no note ID; TikHub resolves the share link
            { note_id: noteId, share_text: noteId ? undefined : snsLink.url },
            endpoint.usage,
          );

          const note = parseXhsNote(data, noteId);
          if (note.media.length === 0) {
            throw new Error("No media found in Xiaohongshu note");
          }

          return note;
        },
      })),
    );
  }

  async fetchContent(
    snsLink: SnsLink<XiaohongshuMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<XiaohongshuMetadata>[]> {
    const note = await this.fetchNote(snsLink);

    progressCallback?.(`Downloading ${note.media.length} xhs media...`);

    const downloads: Promise<File>[] = [];
    for (const m of note.media) {
      if (m.imageUrl) {
        downloads.push(downloadMedia(m.imageUrl, "jpg", XHS_REFERER));
      }
      if (m.videoUrl) {
        downloads.push(downloadMedia(m.videoUrl, "mp4", XHS_REFERER));
      }
    }
    const files = await Promise.all(downloads);

    const text = [note.title, note.desc]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n\n");

    progressCallback?.("Downloaded!", true);

    return [
      {
        postLink: snsLink,
        username: note.username,
        postID: note.noteId ?? snsLink.metadata.noteId ?? "unknown",
        originalText: text,
        timestamp: note.timestamp,
        files,
      },
    ];
  }

  buildDiscordAttachments(
    postData: PostData<XiaohongshuMetadata>,
  ): MessageCreateOptions[] {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer).setName(
        `xhs-${postData.postID}-${i + 1}.${file.ext}`,
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
    postData: PostData<XiaohongshuMetadata>,
    attachmentURLs: string[],
    template?: string,
  ): MessageCreateOptions[] {
    if (template) {
      return buildLinksFormatMessages(template, postData, attachmentURLs);
    }

    let mainPostContent = formatDiscordTitle(
      "xiaohongshu",
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
