import {
  ActionRowBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SendableChannels,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { isConnectionMonitored, type ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import type { AnySnsMetadata, SnsLink } from "../../platforms/base";
import { MediaTooLargeError, sendPostToChannel } from "../../utils/discord";
import { parseUsernameFromUrl } from "../../utils/socialUrls";
import type { MonitorsConfig } from "../config";
import { connectionIdFromPlatformUsername } from "../service/connectionId";
import type { MonitorRepository } from "../data/repository";
import { findAllSnsLinks, snsService } from "../../handlers/sns";

const log = logger.child({ module: "monitor/handlers/post" });

export type ConfirmationResult =
  | { confirmed: true }
  | { confirmed: false; reason: "skipped" | "timeout" | "error" };

export class PostHandler {
  constructor(
    private readonly repo: MonitorRepository,
    private readonly config: MonitorsConfig,
    private readonly serverConfig: ServerConfig | null,
  ) {}

  async promptRepostConfirmation(
    interaction: ChatInputCommandInteraction,
    socialsChannelId: string,
    existingMessageId: string | null,
  ): Promise<ConfirmationResult> {
    const existingPostLink = existingMessageId && interaction.guildId
      ? `\nhttps://discord.com/channels/${interaction.guildId}/${socialsChannelId}/${existingMessageId}`
      : "";

    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("post_confirm_yes")
        .setLabel("✅ Post Anyway")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("post_confirm_no")
        .setLabel("❌ Skip")
        .setStyle(ButtonStyle.Danger),
    );

    const confirmMsg = await interaction.followUp({
      content: `⚠️ This post was already sent to the socials channel.${existingPostLink}\n\nDo you want to post it again?`,
      components: [confirmRow],
      flags: MessageFlags.Ephemeral,
    });

    try {
      const confirmation = await confirmMsg.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === interaction.user.id,
        time: 30_000,
      });

      if (confirmation.customId === "post_confirm_no") {
        await confirmMsg.edit({
          content: "⏭️ Skipped.",
          components: [],
        });
        return { confirmed: false, reason: "skipped" };
      }

      await confirmMsg.edit({
        content: "🔄 Posting again...",
        components: [],
      });
      return { confirmed: true };
    } catch {
      await confirmMsg.edit({
        content: "⏰ Confirmation timed out — skipping post.",
        components: [],
      }).catch(() => {});

      return { confirmed: false, reason: "timeout" };
    }
  }

  async handlePostCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply();

    const postUrl = interaction.options.getString("url", true);
    log.debug({ requester: interaction.user.username, url: postUrl }, "Processing /post");

    const posts = findAllSnsLinks(postUrl);
    if (posts.length === 0) {
      await interaction.editReply("❌ No valid social media links found.");
      return;
    }

    const socialsChannel = await interaction.client.channels.fetch(this.config.socials_channel_id);
    if (!socialsChannel || !("send" in socialsChannel)) {
      await interaction.editReply("❌ Could not find the socials channel.");
      return;
    }

    try {
      const link = posts[0];
      const platform = link.metadata.platform;
      const normalizedPlatform = platform.replace(/-story$/, "");

      const { username, postId, canCheckBeforeFetch } = extractConnectionInfo(link);

      if (canCheckBeforeFetch && username && postId) {
        const preConnectionId = connectionIdFromPlatformUsername(normalizedPlatform, username);
        const confirmed = await this.checkDuplicateBeforeFetch(
          preConnectionId,
          postId,
          interaction,
        );
        if (!confirmed) return;
      }

      const postData = (await snsService(posts, async () => {}).next()).value?.[0];
      if (!postData || !postData.postID) {
        await interaction.editReply("❌ Could not fetch post content.");
        return;
      }

      if ((platform === "instagram" || platform === "instagram-story") && postData.username) {
        const igConnectionId = connectionIdFromPlatformUsername(
          normalizedPlatform,
          postData.username,
        );
        if (isConnectionMonitored(this.config, igConnectionId)) {
          const confirmed = await this.checkDuplicateBeforeFetch(
            igConnectionId,
            postData.postID,
            interaction,
          );
          if (!confirmed) return;
        }
      }

      const trackInDb =
        (platform === "instagram" || platform === "instagram-story") &&
        !!postData.username &&
        isConnectionMonitored(
          this.config,
          connectionIdFromPlatformUsername(normalizedPlatform, postData.username),
        );

      const connectionIdForDb = trackInDb
        ? connectionIdFromPlatformUsername(normalizedPlatform, postData.username!)
        : undefined;

      const result = await sendPostToChannel(socialsChannel as SendableChannels, postData, {
        format: this.config.format,
        template: this.config.template,
        ...(trackInDb && connectionIdForDb && postData.postID
          ? {
              postTracking: {
                connectionId: connectionIdForDb,
                postId: postData.postID,
                sink: this.repo,
              },
            }
          : {}),
      });

      const jumpLink = result.messageIds[0]
        ? `\nhttps://discord.com/channels/${interaction.guildId}/${socialsChannel.id}/${result.messageIds[0]}`
        : "";

      await interaction.editReply(`✅ Post sent to socials channel!${jumpLink}`);
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        await interaction.editReply(
          `❌ Media file is too large to upload (${(err.size / 1024 / 1024).toFixed(1)}MB). Discord's limit is 8MB.\n` +
            `View the post directly: ${postUrl}`,
        );
        return;
      }

      const { requestBody: _body, ...safeErr } = (err as any) ?? {};
      log.error(safeErr, "/post command failed");
      await interaction.followUp({
        content: `❌ Error: ${String(err)}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async checkDuplicateBeforeFetch(
    connectionId: string,
    postId: string,
    interaction: ChatInputCommandInteraction,
  ): Promise<boolean> {
    if (!isConnectionMonitored(this.config, connectionId)) return true;

    const check = this.repo.checkIfPostWasPosted(connectionId, postId);

    if (check.wasPosted) {
      const result = await this.promptRepostConfirmation(
        interaction,
        this.config.socials_channel_id,
        check.messageId,
      );
      return result.confirmed;
    }
    return true;
  }
}

function extractConnectionInfo(link: SnsLink<AnySnsMetadata>): {
  username?: string;
  postId?: string;
  canCheckBeforeFetch: boolean;
} {
  const { metadata, url } = link;

  switch (metadata.platform) {
    case "twitter":
      return {
        username: metadata.username,
        postId: metadata.id,
        canCheckBeforeFetch: true,
      };

    case "tiktok":
      return {
        username: parseUsernameFromUrl(url),
        postId: metadata.videoId,
        canCheckBeforeFetch: true,
      };

    case "instagram":
    case "instagram-story":
      return {
        username: metadata.username,
        postId: metadata.shortcode,
        canCheckBeforeFetch: false,
      };

    default:
      return { username: undefined, postId: undefined, canCheckBeforeFetch: false };
  }
}
