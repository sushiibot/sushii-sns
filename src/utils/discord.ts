import { sleep } from "bun";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { platformToString, type AnySnsMetadata, type Platform, type PostData } from "../platforms/base";
import {
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  type Message,
  type SendableChannels,
} from "discord.js";
import { buildInlineFormatContent, buildLinksFormatMessages, suppressLinksInTextExceptLast } from "./template";
import type { PostTrackingSink } from "../monitor/data/postTracking";
import logger from "../logger";

const log = logger.child({ module: "utils/discord" });

dayjs.extend(utc);
dayjs.extend(timezone);

export const KST_TIMEZONE = "Asia/Seoul";
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export function formatDiscordTitle(
  platform: Platform,
  username: string,
  date?: Date,
): string {
  const djs = dayjs(date).tz(KST_TIMEZONE);

  let title = "`";
  if (date) {
    title += djs.format("YYMMDD");
    title += " ";
  }

  const platformName = platformToString(platform);
  title += `${username} ${platformName} Update`;
  title += "`";

  return title;
}

// joins items into a string with a separator, multiple chunks with max
// length of 2000 characters
export function itemsToMessageContents(
  initialMsg: string,
  items: string[],
): string[] {
  const msgs = [];
  let currentMsg = initialMsg;

  for (const item of items) {
    if (currentMsg.length + item.length > 2000) {
      if (currentMsg.length > 0) {
        msgs.push(currentMsg);
      }
      currentMsg = "";
    }

    currentMsg += item + "\n";
  }

  // Push last message if not empty
  if (currentMsg.length > 0) {
    msgs.push(currentMsg);
  }

  return msgs;
}

export function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }

  return chunks;
}

function buildAttachmentName(
  postData: PostData<AnySnsMetadata>,
  index: number,
  ext: string,
): string {
  const { metadata } = postData.postLink;
  const platform = metadata.platform;
  const i = index + 1;

  if (platform === "instagram-story") {
    const ts = postData.timestamp
      ? dayjs(postData.timestamp).tz(KST_TIMEZONE).format("YYMMDD")
      : null;
    return ts
      ? `ig-story-${postData.username}-${ts}-${i}.${ext}`
      : `ig-story-${postData.username}-${i}.${ext}`;
  }

  if (platform === "instagram") {
    return `ig-${postData.username}-${postData.postID}-${i}.${ext}`;
  }

  if (platform === "tiktok") {
    return `tiktok-${postData.username}-${postData.postID}-${i}.${ext}`;
  }

  // twitter
  return `twitter-${postData.username}-${postData.postID}-${i}.${ext}`;
}

export interface SendPostOptions {
  format: "inline" | "links";
  template?: string;
  /** Optional: prefix content (e.g., "Posted by @user") */
  prefix?: string;
  /** Optional: suppress embeds (default: true) */
  suppressEmbeds?: boolean;
  /** Optional: record first sent message id in monitor DB (see PostTrackingSink) */
  postTracking?: {
    guildId: string;
    connectionId: string;
    postId: string;
    sink: PostTrackingSink;
  };
  /** Optional: override the text-content of the post */
  contentOverride?: string;
}

export interface SendPostResult {
  /** All message IDs that were sent (in order) */
  messageIds: string[];
  /** The full Message objects if you need to reference them immediately */
  messages: Message[];
}

function isAlreadyCrosspostedError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  const code = (err as { code?: number })?.code;
  if (code === 40066) return true;
  if (/already\s*been\s*published|already\s*published/i.test(msg)) return true;
  return false;
}

/**
 * Send a PostData to a Discord channel using review-style formatting.
 * Handles inline (text+attachments) and links (text+CDN URLs) formats.
 * Automatically chunks attachments to respect Discord's 10-per-message limit.
 * 
 * @returns Object with sent message IDs and Message objects for tracking
 */
export async function sendPostToChannel(
  channel: SendableChannels,
  postData: PostData<AnySnsMetadata>,
  options: SendPostOptions,
): Promise<SendPostResult> {
  const {
    format,
    template,
    prefix,
    suppressEmbeds = true,
    postTracking,
    contentOverride,
  } = options;
  const files = postData.files;

  const hasMedia = files.length > 0;
  const flags = (suppressEmbeds && hasMedia) ? MessageFlags.SuppressEmbeds : undefined;

  const result: SendPostResult = { messageIds: [], messages: [] };

  // Helper to send with optional prefix and track result
  const sendAndTrack = async (content: string, extra?: Record<string, unknown>) => {
    const finalContent = prefix ? `${prefix}\n${content}` : content;
    const sent = await channel.send({
      content: finalContent,
      flags,
      ...extra,
    });
    result.messageIds.push(sent.id);
    result.messages.push(sent);
    return sent;
  };

  if (format === "inline") {
    // === INLINE FORMAT: text + direct attachments ===
    const content =
      contentOverride !== undefined
        ? contentOverride
        : buildInlineFormatContent(template ?? "", postData as any);
    const attachments = files.map((f, i) =>
      new AttachmentBuilder(f.buffer).setName(buildAttachmentName(postData, i, f.ext))
    );
    const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);

    if (chunks.length === 0) {
      // Text-only post
      await sendAndTrack(suppressLinksInTextExceptLast?.(content) ?? content);
    } else {
      const sentMessages: Message[] = [];
      try {
        // First message: text content + first chunk of attachments combined
        const firstMsg = await sendAndTrack(content, { files: chunks[0] });
        sentMessages.push(firstMsg);
        // Additional messages for remaining attachment chunks
        for (const chunk of chunks.slice(1)) {
          const sent = await channel.send({ files: chunk, flags });
          result.messageIds.push(sent.id);
          result.messages.push(sent);
          sentMessages.push(sent);
        }
      } catch (err) {
        // Clean up already-sent messages to avoid orphaned text in the channel
        for (const msg of sentMessages) {
          try { await msg.delete(); } catch { /* ignore */ }
        }
        throw err;
      }
    }
  } else {
    // === LINKS FORMAT: upload attachments → get CDN URLs → send text with URLs ===
    const attachments = files.map((f, i) =>
      new AttachmentBuilder(f.buffer).setName(buildAttachmentName(postData, i, f.ext))
    );
    const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);
    const cdnUrls: string[] = [];
    const sentMessages: Message[] = [];

    try {
      // Upload all media first to get Discord CDN URLs
      for (const chunk of chunks) {
        const sent = await channel.send({ files: chunk, flags });
        result.messageIds.push(sent.id);
        result.messages.push(sent);
        sentMessages.push(sent);
        for (const att of sent.attachments.values()) {
          cdnUrls.push(att.url);
        }
      }

      // Build and send formatted text messages with CDN URLs
      const textMsgs = buildLinksFormatMessages(
        template ?? "",
        postData as any,
        cdnUrls,
        contentOverride,
      );
      for (const msg of textMsgs) {
        const sent = await channel.send({ ...msg, flags });
        result.messageIds.push(sent.id);
        result.messages.push(sent);
        sentMessages.push(sent);
      }
    } catch (err) {
      // Clean up already-sent messages to avoid orphaned uploads in the channel
      for (const msg of sentMessages) {
        try { await msg.delete(); } catch { /* ignore */ }
      }
      throw err;
    }
  }

  if (postTracking && result.messageIds.length > 0) {
    try {
      const discordUrl = `https://discord.com/channels/${postTracking.guildId}/${channel.id}/${result.messageIds[0]}`;
      postTracking.sink.recordPosted(
        postTracking.guildId,
        postTracking.connectionId,
        postTracking.postId,
        discordUrl,
      );
    } catch (err) {
      log.error(err, "Failed to track posted message ID in DB");
    }
  }

  if (channel.type === ChannelType.GuildAnnouncement && result.messages.length > 0) {
    const messages = result.messages;
    void (async () => {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        try {
          await m.crosspost();
        } catch (err) {
          if (!isAlreadyCrosspostedError(err)) {
            log.warn({ err, messageId: m.id }, "Failed to crosspost");
          }
        }
      }
    })().catch((err) => {
      log.error(err, "crosspost background task failed");
    });
  }

  return result;
}