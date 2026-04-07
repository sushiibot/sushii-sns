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
import { MediaTooLargeError, sendPostToChannel, type SendPostResult } from "../../utils/discord";
import { buildReviewBatches, buildReviewStatusEditOptions } from "../view/review";
import type { PostQueue } from "../service/queue";
import type { MonitorRepository } from "../data/repository";
import {
  REVIEW_MODAL_PREFIX,
  type ReviewState,
} from "../service/review/types";
import type { ReviewStore } from "../service/review/store";

const log = logger.child({ module: "monitor/handlers/review" });

const CLEANUP_DELAY_MS = 5_000;

const TEXT_ONLY_PLATFORMS = new Set(["twitter"]);

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
  ) {}

  private async replyNotFetcher(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    await interaction.reply({
      content: "Only the person who triggered the fetch can interact.",
      flags: MessageFlags.Ephemeral,
    });
  }

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
      await this.replyNotFetcher(interaction);
      return;
    }

    await interaction.deferUpdate();

    const removedIndices = new Set(interaction.values.map(Number).filter(n => !isNaN(n)));
    this.reviewStore.update(reviewId, { removedIndices });

    const updatedState = this.reviewStore.get(reviewId);
    if (!updatedState) return; // deleted between get and update

    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return;

    await this.editReviewMessages(channel, updatedState, reviewId);
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
      await this.replyNotFetcher(interaction);
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

    if (interaction.user.id !== state.fetcherUserId) {
      await interaction.reply({
        content: "Only the person who triggered the fetch can interact.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    const rawInput = interaction.fields.getTextInputValue("content");
    const customContent = rawInput.trim() || null;

    const currentContent = state.customContent ?? state.renderedContent;
    if (customContent === currentContent) {
      return;
    }

    this.reviewStore.update(reviewId, { customContent });

    const updatedState = this.reviewStore.get(reviewId);
    if (!updatedState) return; // deleted between get and update

    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return;

    await this.editReviewMessages(channel, updatedState, reviewId);
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
      await this.replyNotFetcher(interaction);
      return;
    }

    const filteredFiles = state.postData.files.filter(
      (_, i) => !state.removedIndices.has(i),
    );

    if (filteredFiles.length === 0 && !TEXT_ONLY_PLATFORMS.has(state.postData.postLink.metadata.platform)) {
      await interaction.reply({
        content: "No images selected. Re-add images before posting.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Delete synchronously before any await so a second rapid click finds no
    // state and hits the early return, preventing double-posts.
    // The captured `state` variable remains valid for the rest of the method.
    this.reviewStore.delete(reviewId);

    await interaction.deferUpdate();

    const reviewChannel = interaction.channel;
    if (!reviewChannel || !reviewChannel.isTextBased()) {
      await interaction.followUp({ content: "Cannot find the review channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    const lastMsgId = state.messageIds[state.messageIds.length - 1];

    await editStatusMessage(reviewChannel, lastMsgId, "⏳ Posting...");

    // The actual posting happens asynchronously via the queue.
    // Status is updated directly in the review channel messages.
    this.postQueue.enqueue(() =>
      this.postReviewToSocials(
        state,
        reviewId,
        filteredFiles,
        interaction,
        reviewChannel,
        lastMsgId,
      ),
    ).catch((err) => {
      log.error({ err }, "Post queue job failed unexpectedly");
    });
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
      await this.replyNotFetcher(interaction);
      return;
    }

    await interaction.deferUpdate();

    this.reviewStore.delete(reviewId);

    const reviewChannel = interaction.channel;
    if (!reviewChannel || !reviewChannel.isTextBased()) return;

    const lastMsgId = state.messageIds[state.messageIds.length - 1];

    await this.deleteReviewMediaMessages(reviewChannel, state.messageIds);

    await editStatusMessage(reviewChannel, lastMsgId, "⏭️ Skipped");

    if (lastMsgId) {
      // Intentional fire-and-forget: 5s delay is short and catch prevents noise
      // if the bot shuts down before the timer fires.
      setTimeout(async () => {
        try {
          await reviewChannel.messages.delete(lastMsgId);
        } catch {
          // Already deleted
        }
      }, CLEANUP_DELAY_MS);
    }
  }

  private async deleteReviewMediaMessages(
    channel: TextBasedChannel,
    messageIds: string[],
  ): Promise<void> {
    for (let i = 0; i < messageIds.length - 1; i++) {
      const msgId = messageIds[i];
      try { await channel.messages.delete(msgId); } catch { /* already gone */ }
    }
  }

  private async editReviewMessages(
    channel: TextBasedChannel,
    state: ReviewState,
    reviewId: string,
  ): Promise<void> {
    const batches = buildReviewBatches(state, reviewId);
    for (let i = 0; i < batches.length; i++) {
      const msgId = state.messageIds[i];
      if (!msgId) continue;
      try {
        const msg = await channel.messages.fetch(msgId);
        await msg.edit({
          flags: MessageFlags.IsComponentsV2,
          components: batches[i].components as MessageEditOptions["components"],
          content: null,
          embeds: [],
        });
      } catch (err) {
        log.warn({ err, msgId }, "Failed to update review message");
      }
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
    try {
      const channel = await interaction.client.channels.fetch(state.socialsChannelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        // Clean up media batch messages so channel isn't cluttered
        await this.deleteReviewMediaMessages(reviewChannel, state.messageIds);
        await editStatusMessage(reviewChannel, lastMsgId, "❌ Failed - channel not sendable");
        return;
      }

      const filteredPostData = { ...state.postData, files: filteredFiles };

      let result: SendPostResult;
      try {
        result = await sendPostToChannel(channel as SendableChannels, filteredPostData, {
          format: state.format,
          template: state.template,
          postTracking: {
            guildId: state.guildId,
            connectionId: state.connectionId,
            postId: state.postData.postID,
            sink: this.repo,
          },
          ...(state.customContent != null ? { contentOverride: state.customContent } : {}),
        });
      } catch (err) {
        log.error({ err, channelId: state.socialsChannelId }, "Failed to post to socials channel");
        // Clean up media batch messages so channel isn't cluttered
        await this.deleteReviewMediaMessages(reviewChannel, state.messageIds);
        if (err instanceof MediaTooLargeError) {
          await editStatusMessage(
            reviewChannel,
            lastMsgId,
            `❌ Media too large to post (${(err.size / 1024 / 1024).toFixed(1)} MB).`,
          );
          return;
        }
        const msg =
          err instanceof Error && err.message.toLowerCase().includes("timed out")
            ? "❌ Timeout while posting"
            : "❌ Failed to post";
        await editStatusMessage(reviewChannel, lastMsgId, msg);
        return;
      }

      // Post succeeded — now safe to clean up the review messages.
      await this.deleteReviewMediaMessages(reviewChannel, state.messageIds);

      const guildId = interaction.guildId;
      const firstId = result.messageIds[0];
      const postedLine =
        guildId && firstId
          ? `✅ Posted! https://discord.com/channels/${guildId}/${state.socialsChannelId}/${firstId}`
          : "✅ Posted! (open the socials channel to see the message.)";

      await editStatusMessage(reviewChannel, lastMsgId, postedLine);

      // Intentional fire-and-forget: 5s delay is short and catch prevents noise
      // if the bot shuts down before the timer fires.
      setTimeout(async () => {
        try {
          if (lastMsgId) await reviewChannel.messages.delete(lastMsgId);
        } catch {
          // Already deleted
        }
      }, CLEANUP_DELAY_MS);
    } catch (err) {
      log.error({ err, channelId: state.socialsChannelId }, "Unexpected error in postReviewToSocials");
      // Clean up media batch messages so channel isn't cluttered
      await this.deleteReviewMediaMessages(reviewChannel, state.messageIds);
      await editStatusMessage(reviewChannel, lastMsgId, "❌ Failed to post");
    }
  }
}
