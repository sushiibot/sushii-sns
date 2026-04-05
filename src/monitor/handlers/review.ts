import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type MessageEditOptions,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from "discord.js";
import logger from "../../logger";
import { sendPostToChannel, type SendPostResult } from "../../utils/discord";
import { buildReviewBatches, buildReviewStatusEditOptions } from "../view/review";
import { connectionIdFromPlatformUsername } from "../service/connectionId";
import type { PostQueue } from "../service/queue";
import type { MonitorRepository } from "../data/repository";
import type { MonitorsConfig } from "../config";
import {
  REVIEW_MODAL_PREFIX,
  type ReviewState,
} from "../service/review/types";
import type { ReviewStore } from "../service/review/store";

const log = logger.child({ module: "monitor/handlers/review" });

async function editStatusMessage(
  channel: TextBasedChannel,
  msgId: string | undefined,
  text: string,
): Promise<void> {
  if (!msgId) return;
  try {
    const msg = await channel.messages.fetch(msgId);
    await msg.edit(buildReviewStatusEditOptions(text));
  } catch (err) {
    log.warn({ err, msgId }, "Failed to edit review status message");
  }
}

export class ReviewHandler {
  constructor(
    private readonly reviewStore: ReviewStore,
    private readonly postQueue: PostQueue,
    private readonly repo: MonitorRepository,
    private readonly config: MonitorsConfig,
  ) {}

  async handleRemove(
    interaction: StringSelectMenuInteraction,
    reviewId: string,
  ): Promise<void> {
    const state = this.reviewStore.get(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.deferUpdate();
      return;
    }

    if (interaction.user.id !== state.fetcherUserId) {
      await interaction.deferUpdate();
      return;
    }

    await interaction.deferUpdate();

    const removedIndices = new Set(interaction.values.map(Number));
    this.reviewStore.update(reviewId, { removedIndices });

    const updatedState = this.reviewStore.get(reviewId)!;
    const batches = buildReviewBatches(updatedState, reviewId);

    const channel = interaction.channel;
    if (!channel) return;

    for (let i = 0; i < batches.length; i++) {
      const msgId = updatedState.messageIds[i];
      if (!msgId) continue;

      try {
        const msg = await channel.messages.fetch(msgId);
        const editOptions = {
          flags: MessageFlags.IsComponentsV2,
          components: batches[i].components as any,
          content: null,
          embeds: [],
        } as unknown as MessageEditOptions;

        await msg.edit(editOptions);
      } catch (err) {
        log.warn({ err, msgId }, "Failed to update review message");
      }
    }
  }

  async handleEdit(
    interaction: ButtonInteraction,
    reviewId: string,
  ): Promise<void> {
    const state = this.reviewStore.get(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.reply({ content: "This review has expired.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.user.id !== state.fetcherUserId) {
      await interaction.reply({
        content: "Only the person who triggered the fetch can interact.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const textInput = new TextInputBuilder()
      .setCustomId("content")
      .setLabel("Post text")
      .setStyle(TextInputStyle.Paragraph)
      .setValue(state.customContent ?? state.renderedContent)
      .setMaxLength(2000);

    const modal = new ModalBuilder()
      .setCustomId(`${REVIEW_MODAL_PREFIX}${reviewId}`)
      .setTitle("Edit Post Text")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
      );

    await interaction.showModal(modal);
  }

  async handleModalSubmit(
    interaction: ModalSubmitInteraction,
    reviewId: string,
  ): Promise<void> {
    const state = this.reviewStore.get(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.reply({ content: "This review has expired.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();

    const customContent = interaction.fields.getTextInputValue("content");

    const currentContent = state.customContent ?? state.renderedContent;
    if (customContent === currentContent) {
      return;
    }

    this.reviewStore.update(reviewId, { customContent });

    const updatedState = this.reviewStore.get(reviewId)!;
    const batches = buildReviewBatches(updatedState, reviewId);

    const channel = interaction.channel;
    if (!channel) return;

    const msgId = updatedState.messageIds[0];
    if (!msgId) return;

    try {
      const msg = await channel.messages.fetch(msgId);
      const editOptions = {
        flags: MessageFlags.IsComponentsV2,
        components: batches[0].components as any,
        content: null,
        embeds: [],
      } as unknown as MessageEditOptions;

      await msg.edit(editOptions);
    } catch (err) {
      log.warn({ err, msgId }, "Failed to update review message");
    }
  }

  async handlePost(
    interaction: ButtonInteraction,
    reviewId: string,
  ): Promise<void> {
    const state = this.reviewStore.get(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.reply({ content: "This review has expired.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.user.id !== state.fetcherUserId) {
      await interaction.reply({
        content: "Only the person who triggered the fetch can interact.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const filteredFiles = state.postData.files.filter(
      (_, i) => !state.removedIndices.has(i),
    );

    if (filteredFiles.length === 0 && state.postData.postLink.metadata.platform !== "twitter") {
      await interaction.reply({
        content: "No images selected. Re-add images before posting.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    const reviewChannel = interaction.channel;
    if (!reviewChannel || !reviewChannel.isTextBased()) return;

    const lastMsgId = state.messageIds[state.messageIds.length - 1];

    for (let i = 0; i < state.messageIds.length - 1; i++) {
      const msgId = state.messageIds[i];
      try {
        await reviewChannel.messages.delete(msgId);
      } catch {
        // Already deleted or missing
      }
    }

    await editStatusMessage(reviewChannel, lastMsgId, "⏳ Posting...");

    this.postQueue.enqueue(() =>
      this.postReviewToSocials(
        state,
        reviewId,
        filteredFiles,
        interaction,
        reviewChannel,
        lastMsgId,
      ),
    );
  }

  async handleSkip(
    interaction: ButtonInteraction,
    reviewId: string,
  ): Promise<void> {
    const state = this.reviewStore.get(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.reply({ content: "This review has expired.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.user.id !== state.fetcherUserId) {
      await interaction.reply({
        content: "Only the person who triggered the fetch can interact.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    this.reviewStore.delete(reviewId);

    const reviewChannel = interaction.channel;
    if (!reviewChannel || !reviewChannel.isTextBased()) return;

    const lastMsgId = state.messageIds[state.messageIds.length - 1];

    for (let i = 0; i < state.messageIds.length - 1; i++) {
      const msgId = state.messageIds[i];
      try {
        await reviewChannel.messages.delete(msgId);
      } catch {
        // Already deleted
      }
    }

    await editStatusMessage(reviewChannel, lastMsgId, "⏭️ Skipped");

    if (lastMsgId) {
      setTimeout(async () => {
        try {
          await reviewChannel.messages.delete(lastMsgId);
        } catch {
          // Already deleted
        }
      }, 5000);
    }
  }

  private async postReviewToSocials(
    state: ReviewState,
    reviewId: string,
    filteredFiles: ReviewState["postData"]["files"],
    interaction: ButtonInteraction,
    reviewChannel: TextBasedChannel,
    lastMsgId: string | undefined,
  ): Promise<void> {
    const channel = await interaction.client.channels.fetch(state.socialsChannelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      await editStatusMessage(reviewChannel, lastMsgId, "❌ Failed - channel not sendable");
      return;
    }

    const normalizedPlatform = state.postData.postLink.metadata.platform.replace(/-story$/, "");
    const connectionId = connectionIdFromPlatformUsername(
      normalizedPlatform,
      state.postData.username,
    );
    const filteredPostData = { ...state.postData, files: filteredFiles };

    let result: SendPostResult;
    try {
      result = await sendPostToChannel(channel as SendableChannels, filteredPostData, {
        format: state.format as "inline" | "links",
        template: state.template,
        postTracking: {
          connectionId,
          postId: state.postData.postID,
          sink: this.repo,
        },
        ...(state.customContent != null ? { contentOverride: state.customContent } : {}),
      });
    } catch (err) {
      log.error({ err, channelId: state.socialsChannelId }, "Failed to post to socials channel");
      const msg =
        err instanceof Error && err.message.toLowerCase().includes("timed out")
          ? "❌ Timeout while posting"
          : "❌ Failed to post";
      await editStatusMessage(reviewChannel, lastMsgId, msg);
      return;
    }

    this.reviewStore.delete(reviewId);

    const guildId = interaction.guildId;
    const firstId = result.messageIds[0];
    const postedLine =
      guildId && firstId
        ? `✅ Posted! https://discord.com/channels/${guildId}/${state.socialsChannelId}/${firstId}`
        : "✅ Posted! (open the socials channel to see the message.)";

    await editStatusMessage(reviewChannel, lastMsgId, postedLine);

    setTimeout(async () => {
      try {
        if (lastMsgId) await reviewChannel.messages.delete(lastMsgId);
      } catch {
        // Already deleted
      }
    }, 5000);
  }
}
