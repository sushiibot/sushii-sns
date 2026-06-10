import {
  ActionRowBuilder,
  ContainerBuilder,
  GuildMember,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type MessageEditOptions,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from "discord.js";
import logger from "../../logger";
import { buildReviewBatches, buildReviewLastBatchStatusEdit, buildSkippedEdit } from "../view/review";
import type { PostQueue } from "../service/queue";
import type { MonitorRepository } from "../data/repository";
import {
  REVIEW_MODAL_PREFIX,
  type ReviewState,
} from "../service/review/types";
import { ephemeralError } from "../view/ephemeral";
import { chunkArray, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";

const log = logger.child({ module: "monitor/handlers/review" });

const TEXT_ONLY_PLATFORMS = new Set(["twitter"]);

export class ReviewHandler {
  constructor(
    private readonly postQueue: PostQueue,
    private readonly repo: MonitorRepository,
  ) {}

  private isAuthorized(interaction: RepliableInteraction, triggerRoleId: string | null): boolean {
    if (!triggerRoleId) return true;
    const member = interaction.member;
    if (!member) return false;
    return member instanceof GuildMember
      ? member.roles.cache.has(triggerRoleId)
      : Array.isArray(member.roles) && member.roles.includes(triggerRoleId);
  }

  private async replyUnauthorized(interaction: RepliableInteraction): Promise<void> {
    await interaction.reply({
      content: "You don't have the required role to do this.",
      flags: MessageFlags.Ephemeral,
    });
  }

  async handleRemove(
    interaction: StringSelectMenuInteraction,
    reviewId: string,
  ): Promise<void> {
    const state = this.repo.getPendingReview(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.deferUpdate();
      return;
    }

    const removeConfig = this.repo.getConfig(state.guildId);
    if (!this.isAuthorized(interaction, removeConfig?.trigger_role_id ?? null)) {
      await this.replyUnauthorized(interaction);
      return;
    }

    await interaction.deferUpdate();

    const removedIndices = interaction.values.map(Number).filter(n => !isNaN(n));
    this.repo.updatePendingReview(reviewId, { removedIndices });

    const updatedState = this.repo.getPendingReview(reviewId);
    if (!updatedState) return; // deleted between get and update

    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return;

    await this.editReviewMessages(channel, updatedState, reviewId);
  }

  async handleEdit(
    interaction: ButtonInteraction,
    reviewId: string,
  ): Promise<void> {
    const state = this.repo.getPendingReview(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.reply(ephemeralError("This review has expired."));
      return;
    }

    const editConfig = this.repo.getConfig(state.guildId);
    if (!this.isAuthorized(interaction, editConfig?.trigger_role_id ?? null)) {
      await this.replyUnauthorized(interaction);
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
    const state = this.repo.getPendingReview(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.reply(ephemeralError("This review has expired."));
      return;
    }

    const modalConfig = this.repo.getConfig(state.guildId);
    if (!this.isAuthorized(interaction, modalConfig?.trigger_role_id ?? null)) {
      await this.replyUnauthorized(interaction);
      return;
    }

    await interaction.deferUpdate();

    const rawInput = interaction.fields.getTextInputValue("content");
    const customContent = rawInput.trim() || null;

    const currentContent = state.customContent ?? state.renderedContent;
    if (customContent === currentContent) {
      return;
    }

    this.repo.updatePendingReview(reviewId, { customContent });

    const updatedState = this.repo.getPendingReview(reviewId);
    if (!updatedState) return; // deleted between get and update

    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return;

    await this.editReviewMessages(channel, updatedState, reviewId);
  }

  async handlePost(
    interaction: ButtonInteraction,
    reviewId: string,
  ): Promise<void> {
    const state = this.repo.getPendingReview(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.reply(ephemeralError("This review has expired."));
      return;
    }

    const postConfig = this.repo.getConfig(state.guildId);
    if (!this.isAuthorized(interaction, postConfig?.trigger_role_id ?? null)) {
      await this.replyUnauthorized(interaction);
      return;
    }

    const filteredFiles = state.postData.files.filter(
      (_, i) => !state.removedIndices.has(i),
    );

    if (filteredFiles.length === 0 && !TEXT_ONLY_PLATFORMS.has(state.postData.postLink.metadata.platform)) {
      await interaction.reply(ephemeralError("No images selected. Re-add images before posting."));
      return;
    }

    // Atomically claim the review — if another click beat us, bail out.
    // The captured `state` variable remains valid for the rest of the method.
    const claimed = this.repo.setReviewStatus(reviewId, "posted");
    if (!claimed) {
      await interaction.reply(ephemeralError("This review has already been handled."));
      return;
    }

    await interaction.deferUpdate();

    const reviewChannel = interaction.channel;
    if (!reviewChannel || !reviewChannel.isTextBased()) {
      await interaction.followUp(ephemeralError("Cannot find the review channel."));
      return;
    }

    // Immediately replace buttons with a disabled "Posting..." indicator so
    // the message stays readable while the queue job runs.
    const lastMsgId = state.messageIds.at(-1);
    if (lastMsgId) {
      try {
        const lastMsg = await reviewChannel.messages.fetch(lastMsgId);
        await lastMsg.edit(buildReviewLastBatchStatusEdit(state, "⏳ Posting..."));
      } catch (err) {
        log.warn({ err, lastMsgId }, "Failed to set posting status on review message");
      }
    }

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
    const state = this.repo.getPendingReview(reviewId);
    if (!state) {
      log.warn({ reviewId }, "Review not found");
      await interaction.reply(ephemeralError("This review has expired."));
      return;
    }

    const config = this.repo.getConfig(state.guildId);
    if (!this.isAuthorized(interaction, config?.trigger_role_id ?? null)) {
      await interaction.reply({
        content: "You don't have the required role to do this.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const claimed = this.repo.setReviewStatus(reviewId, "skipped");
    if (!claimed) {
      await interaction.reply(ephemeralError("This review has already been handled."));
      return;
    }

    await interaction.deferUpdate();

    const reviewChannel = interaction.channel;
    if (!reviewChannel || !reviewChannel.isTextBased()) return;

    const lastMsgId = state.messageIds.at(-1);
    if (lastMsgId) {
      try {
        const msg = await reviewChannel.messages.fetch(lastMsgId);
        await msg.edit(buildSkippedEdit(state, reviewId));
      } catch (err) {
        log.warn({ err, lastMsgId }, "Failed to update review to skipped state");
      }
    }
  }

  async handleUndoSkip(
    interaction: ButtonInteraction,
    reviewId: string,
  ): Promise<void> {
    const state = this.repo.getPendingReview(reviewId);
    if (!state) {
      await interaction.reply(ephemeralError("This review has expired."));
      return;
    }

    const config = this.repo.getConfig(state.guildId);
    if (!this.isAuthorized(interaction, config?.trigger_role_id ?? null)) {
      await interaction.reply({
        content: "You don't have the required role to do this.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const reset = this.repo.resetReviewStatus(reviewId);
    if (!reset) {
      await interaction.reply(ephemeralError("This review is no longer in a skipped state."));
      return;
    }

    await interaction.deferUpdate();

    const reviewChannel = interaction.channel;
    if (!reviewChannel || !reviewChannel.isTextBased()) return;

    await this.editReviewMessages(reviewChannel, state, reviewId);
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

  private async updateLastBatchStatus(
    channel: TextBasedChannel,
    state: ReviewState,
    lastMsgId: string | undefined,
    statusText: string,
    postedUrl?: string,
  ): Promise<void> {
    if (!lastMsgId) return;
    try {
      const msg = await channel.messages.fetch(lastMsgId);
      await msg.edit(buildReviewLastBatchStatusEdit(state, statusText, postedUrl));
    } catch (err) {
      log.warn({ err, lastMsgId }, "Failed to update review status");
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
      if (!channel || !channel.isSendable()) {
        await this.updateLastBatchStatus(reviewChannel, state, lastMsgId, "❌ Failed — channel not sendable");
        return;
      }

      const keptUrls: string[] = [];
      for (let i = 0; i < state.fileNames.length; i++) {
        if (state.removedIndices.has(i)) continue;
        const url = state.cdnUrls[i];
        if (url) keptUrls.push(url);
      }

      log.info({ reviewId, total: state.fileNames.length, kept: keptUrls.length, removed: state.removedIndices.size }, "Collected CDN URLs for post");

      if (state.fileNames.length > 0 && keptUrls.length === 0) {
        log.error({ reviewId, fileNames: state.fileNames }, "No CDN URLs found — review may predate CDN URL storage");
        await this.updateLastBatchStatus(reviewChannel, state, lastMsgId, "❌ Failed — images unavailable");
        return;
      }

      const content = state.customContent ?? state.renderedContent;
      const container = new ContainerBuilder();
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

      if (keptUrls.length > 0) {
        container.addSeparatorComponents(
          new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        );
        for (const chunk of chunkArray(keptUrls, MAX_ATTACHMENTS_PER_MESSAGE)) {
          const gallery = new MediaGalleryBuilder();
          for (const url of chunk) {
            gallery.addItems(new MediaGalleryItemBuilder().setURL(url));
          }
          container.addMediaGalleryComponents(gallery);
        }
      }

      let postedDiscordUrl: string | undefined;
      try {
        const sent = await channel.send({
          flags: MessageFlags.IsComponentsV2,
          components: [container],
        });

        // Construct the full Discord URL for this message.
        const discordUrl = interaction.guildId
          ? `https://discord.com/channels/${interaction.guildId}/${state.socialsChannelId}/${sent.id}`
          : null;

        if (discordUrl) {
          postedDiscordUrl = discordUrl;
        }

        // Record the posted message in the DB (equivalent to postTracking in sendPostToChannel).
        if (state.postData.postID && discordUrl) {
          // postID may be a "+"-joined composite for merged story groups — record each.
          const postIds = state.postData.postID.split("+").filter(Boolean);
          for (const postId of postIds) {
            this.repo.recordPosted(state.guildId, state.connectionId, postId, discordUrl);
          }
        }

        // Persist the Discord URL so the review row is queryable after posting.
        if (discordUrl) {
          this.repo.setReviewPostedUrl(reviewId, discordUrl);
        }
      } catch (err) {
        log.error({ err, channelId: state.socialsChannelId }, "Failed to post to socials channel");
        const statusText =
          err instanceof Error && err.message.toLowerCase().includes("timed out")
            ? "❌ Timeout while posting"
            : "❌ Failed to post";
        await this.updateLastBatchStatus(reviewChannel, state, lastMsgId, statusText);
        return;
      }

      await this.updateLastBatchStatus(reviewChannel, state, lastMsgId, "✅ Posted!", postedDiscordUrl);
    } catch (err) {
      log.error({ err, channelId: state.socialsChannelId }, "Unexpected error in postReviewToSocials");
      await this.updateLastBatchStatus(reviewChannel, state, lastMsgId, "❌ Failed to post");
    }
  }
}
