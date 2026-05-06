import {
  ActionRowBuilder,
  type ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { isConnectionMonitored } from "../../config/server_config";
import logger from "../../logger";
import type { AnySnsMetadata, SnsLink } from "../../platforms/base";
import { MediaTooLargeError, sendPostToChannel } from "../../utils/discord";
import { parseUsernameFromUrl } from "../../utils/socialUrls";
import { ConnectionTypeSchema, getConnectionId, type ConnectionType } from "../config";
import type { MonitorRepository } from "../data/repository";
import { findAllSnsLinks, snsService } from "../../handlers/sns";
import { ephemeralConfirm, editError, editSuccess, editInfo } from "../view/ephemeral";

const log = logger.child({ module: "monitor/handlers/post" });

const NOT_CONFIGURED_MSG =
  "Monitor is not configured for this server. Use `/monitor config setup` to get started.";

export type ConfirmationResult =
  | { confirmed: true }
  | { confirmed: false; reason: "skipped" | "timeout" | "error" };

export class PostHandler {
  constructor(private readonly repo: MonitorRepository) {}

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

    const confirmMsg = await interaction.followUp(
      ephemeralConfirm(
        `⚠️ This post was already sent to the socials channel.${existingPostLink}\n\nDo you want to post it again?`,
        confirmRow,
      ),
    );

    try {
      const confirmation = await confirmMsg.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === interaction.user.id,
        time: 30_000,
      });

      if (confirmation.customId === "post_confirm_no") {
        await confirmMsg.edit(editInfo("⏭️ Skipped."));
        return { confirmed: false, reason: "skipped" };
      }

      await confirmMsg.edit(editInfo("🔄 Posting again..."));
      return { confirmed: true };
    } catch {
      await confirmMsg.edit(editInfo("⏰ Confirmation timed out — skipping post.")).catch(() => {});
      return { confirmed: false, reason: "timeout" };
    }
  }

  async handlePostCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply(editError("Must be used in a guild."));
      return;
    }

    const config = this.repo.getConfig(guildId);
    if (!config) {
      await interaction.editReply(editError(NOT_CONFIGURED_MSG));
      return;
    }

    const postUrl = interaction.options.getString("url", true);
    log.debug({ requester: interaction.user.username, url: postUrl }, "Processing /post");

    const posts = findAllSnsLinks(postUrl);
    if (posts.length === 0) {
      await interaction.editReply(editError("❌ No valid social media links found."));
      return;
    }

    const socialsChannel = await interaction.client.channels.fetch(config.socials_channel_id);
    if (!socialsChannel || !socialsChannel.isSendable()) {
      await interaction.editReply(editError("❌ Could not find the socials channel."));
      return;
    }

    try {
      const link = posts[0];
      const platform = link.metadata.platform;
      const normalizedPlatform = platform.replace(/-story$/, "");
      const connectionTypeParsed = ConnectionTypeSchema.safeParse(normalizedPlatform);

      const { username, postId, canCheckBeforeFetch } = extractConnectionInfo(link);

      if (canCheckBeforeFetch && username && postId && connectionTypeParsed.success) {
        const preConnectionId = getConnectionId({ type: connectionTypeParsed.data, handle: username });
        const confirmed = await this.checkDuplicateBeforeFetch(guildId, config, preConnectionId, postId, interaction);
        if (!confirmed) return;
      }

      const postData = (await snsService(posts, async () => {}).next()).value?.[0];
      if (!postData || !postData.postID) {
        await interaction.editReply(editError("❌ Could not fetch post content."));
        return;
      }

      if (
        connectionTypeParsed.success &&
        (platform === "instagram" || platform === "instagram-story") &&
        postData.username
      ) {
        const igConnectionId = getConnectionId({ type: connectionTypeParsed.data, handle: postData.username });
        if (isConnectionMonitored(config, igConnectionId)) {
          const confirmed = await this.checkDuplicateBeforeFetch(guildId, config, igConnectionId, postData.postID, interaction);
          if (!confirmed) return;
        }
      }

      const trackInDb =
        connectionTypeParsed.success &&
        (platform === "instagram" || platform === "instagram-story") &&
        !!postData.username &&
        isConnectionMonitored(
          config,
          getConnectionId({ type: connectionTypeParsed.data, handle: postData.username }),
        );

      const connectionIdForDb = trackInDb && connectionTypeParsed.success
        ? getConnectionId({ type: connectionTypeParsed.data, handle: postData.username! })
        : undefined;

      const result = await sendPostToChannel(socialsChannel, postData, {
        format: config.format,
        template: config.template,
        ...(trackInDb && connectionIdForDb && postData.postID
          ? {
              postTracking: {
                guildId,
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

      await interaction.editReply(editSuccess(`✅ Post sent to socials channel!${jumpLink}`));
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        await interaction.editReply(
          editError(
            `❌ Media file is too large to upload to Discord (${(err.size / 1024 / 1024).toFixed(1)} MB).\n` +
              `View the post directly: ${postUrl}`,
          ),
        );
        return;
      }

      const { requestBody: _body, ...safeErr } = (err as any) ?? {};
      log.error(safeErr, "/post command failed");
      try {
        await interaction.editReply(editError("❌ Something went wrong. Please try again."));
      } catch {
        // editReply can fail if deferReply never completed
      }
    }
  }

  private async checkDuplicateBeforeFetch(
    guildId: string,
    config: { connections: Array<{ type: string; handle: string }>; socials_channel_id: string },
    connectionId: string,
    postId: string,
    interaction: ChatInputCommandInteraction,
  ): Promise<boolean> {
    if (!isConnectionMonitored(config, connectionId)) return true;

    const check = this.repo.checkIfPostWasPublished(guildId, connectionId, postId);
    if (check.wasPosted) {
      const result = await this.promptRepostConfirmation(interaction, config.socials_channel_id, check.messageId);
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
      return { username: metadata.username, postId: metadata.id, canCheckBeforeFetch: true };
    case "tiktok":
      return { username: parseUsernameFromUrl(url), postId: metadata.videoId, canCheckBeforeFetch: true };
    case "instagram":
    case "instagram-story":
      return { username: metadata.username, postId: metadata.shortcode, canCheckBeforeFetch: false };
    default:
      return { username: undefined, postId: undefined, canCheckBeforeFetch: false };
  }
}
