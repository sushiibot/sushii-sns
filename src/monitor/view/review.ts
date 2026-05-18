import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  escapeMarkdown,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import { chunkArray, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import { ACCENT_BLUE } from "./colors";
import {
  REVIEW_EDIT_PREFIX,
  REVIEW_POST_PREFIX,
  REVIEW_REMOVE_PREFIX,
  REVIEW_SKIP_PREFIX,
  REVIEW_UNDO_SKIP_PREFIX,
  type ReviewState,
} from "../service/review/types";

type ReviewComponent = ContainerBuilder;

/**
 * Represents one message batch in a multi-message review.
 */
export interface ReviewMessageBatch {
  files: AttachmentBuilder[];
  components: ReviewComponent[];
  isLast: boolean;
}

/**
 * Build all message batches for a review.
 * - First N-1 messages: Just images with simple headers
 * - Last message: Images + dropdown (all images) + action buttons
 */
export function buildReviewBatches(
  state: ReviewState,
  reviewId: string,
): ReviewMessageBatch[] {
  const batches: ReviewMessageBatch[] = [];
  const files = state.postData.files;
  const fileChunks = chunkArray(files, MAX_ATTACHMENTS_PER_MESSAGE);
  const allFileNames = state.fileNames;

  if (fileChunks.length === 0) {
    const components = buildControlComponents(state, reviewId, 0);
    batches.push({ files: [], components, isLast: true });
    return batches;
  }

  for (let i = 0; i < fileChunks.length; i++) {
    const chunk = fileChunks[i];
    const startIdx = i * MAX_ATTACHMENTS_PER_MESSAGE;
    const isLast = i === fileChunks.length - 1;

    const batchFileNames = chunk.map((_, idx) => allFileNames[startIdx + idx]);
    const batchAttachments = chunk.map((f, idx) =>
      new AttachmentBuilder(f.buffer).setName(batchFileNames[idx])
    );

    if (isLast) {
      const components = buildControlComponents(state, reviewId, startIdx);
      batches.push({ files: batchAttachments, components, isLast: true });
    } else {
      const components = buildSimpleComponents(state, i, startIdx);
      batches.push({ files: batchAttachments, components, isLast: false });
    }
  }

  return batches;
}

function buildSimpleComponents(
  state: ReviewState,
  chunkIndex: number,
  startIdx: number,
): ReviewComponent[] {
  const allFileNames = state.fileNames;
  const container = new ContainerBuilder().setAccentColor(ACCENT_BLUE);

  if (chunkIndex === 0) {
    const headerText = state.customContent ?? state.renderedContent;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
  } else {
    const endIdx = Math.min(startIdx + MAX_ATTACHMENTS_PER_MESSAGE, allFileNames.length);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`📎 Images ${startIdx + 1}–${endIdx}`)
    );
  }

  const gallery = new MediaGalleryBuilder();
  const chunkLen = Math.min(MAX_ATTACHMENTS_PER_MESSAGE, allFileNames.length - startIdx);
  for (let i = 0; i < chunkLen; i++) {
    const globalIdx = startIdx + i;
    if (globalIdx >= allFileNames.length) break;

    const isRemoved = state.removedIndices.has(globalIdx);
    const item = new MediaGalleryItemBuilder().setURL(`attachment://${allFileNames[globalIdx]}`);
    if (isRemoved) { item.setDescription(`❌ Image ${globalIdx + 1} — removing`); }
    gallery.addItems(item);
  }
  container.addMediaGalleryComponents(gallery);

  return [container];
}

function buildControlComponents(
  state: ReviewState,
  reviewId: string,
  startIdx: number,
): ReviewComponent[] {
  const allFileNames = state.fileNames;
  const container = new ContainerBuilder().setAccentColor(ACCENT_BLUE);

  if (startIdx === 0) {
    const headerText = state.customContent ?? state.renderedContent;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
  }

  if (allFileNames.length > 0) {
    const gallery = new MediaGalleryBuilder();
    for (let i = startIdx; i < allFileNames.length; i++) {
      const isRemoved = state.removedIndices.has(i);
      const item = new MediaGalleryItemBuilder().setURL(`attachment://${allFileNames[i]}`);
      if (isRemoved) { item.setDescription(`❌ Image ${i + 1} — removing`); }
      gallery.addItems(item);
    }
    container.addMediaGalleryComponents(gallery);
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  if (state.fetcherUsername) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# Fetched by ${escapeMarkdown(state.fetcherUsername)}`)
    );
  }

  if (allFileNames.length > 1) {
    const fileOptions = allFileNames.map((name, i) => {
      const ext = name.split(".").pop()?.toUpperCase() ?? "FILE";
      const chunkNum = Math.floor(i / MAX_ATTACHMENTS_PER_MESSAGE) + 1;
      const label = chunkNum > 1
        ? `Image ${i + 1} (${ext}) — batch ${chunkNum}`
        : `Image ${i + 1} (${ext})`;

      return new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setValue(String(i))
        .setDefault(state.removedIndices.has(i));
    });

    const options = fileOptions.slice(0, 25); // Discord limit: 25 options per select menu

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`${REVIEW_REMOVE_PREFIX}${reviewId}`)
      .setPlaceholder(`Select images to remove from all ${allFileNames.length} images...`)
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options);

    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
    );
  }

  const editButton = new ButtonBuilder()
    .setCustomId(`${REVIEW_EDIT_PREFIX}${reviewId}`)
    .setLabel("Edit Text")
    .setEmoji("✏️")
    .setStyle(ButtonStyle.Secondary);

  const postButton = new ButtonBuilder()
    .setCustomId(`${REVIEW_POST_PREFIX}${reviewId}`)
    .setLabel("Post")
    .setEmoji("✅")
    .setStyle(ButtonStyle.Success);

  const skipButton = new ButtonBuilder()
    .setCustomId(`${REVIEW_SKIP_PREFIX}${reviewId}`)
    .setLabel("Skip")
    .setEmoji("⏭️")
    .setStyle(ButtonStyle.Danger);

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(editButton, postButton, skipButton),
  );

  return [container];
}

/**
 * Convert batches to MessageCreateOptions for sending.
 */
export function batchToMessageOptions(
  batch: ReviewMessageBatch,
): MessageCreateOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    files: batch.files,
    components: batch.components as MessageCreateOptions["components"],
    allowedMentions: { parse: [] },
  };
}

/**
 * Build a ContainerBuilder with the last batch's header (if first batch), gallery,
 * and a separator — shared scaffolding for status-edit and skipped-edit functions.
 */
function buildLastBatchContainer(state: ReviewState): ContainerBuilder {
  const { fileNames, removedIndices, messageIds, customContent, renderedContent } = state;
  const startIdx = (messageIds.length - 1) * MAX_ATTACHMENTS_PER_MESSAGE;
  const container = new ContainerBuilder().setAccentColor(ACCENT_BLUE);

  if (startIdx === 0) {
    const headerText = customContent ?? renderedContent;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
  }

  if (fileNames.length > 0) {
    const gallery = new MediaGalleryBuilder();
    for (let i = startIdx; i < fileNames.length; i++) {
      const isRemoved = removedIndices.has(i);
      const item = new MediaGalleryItemBuilder().setURL(`attachment://${fileNames[i]}`);
      if (isRemoved) { item.setDescription(`❌ Image ${i + 1} — removing`); }
      gallery.addItems(item);
    }
    container.addMediaGalleryComponents(gallery);
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  return container;
}

/**
 * Build edit options for the last batch that preserve full content (text + gallery)
 * but replace interactive controls with a single disabled status button.
 * Used for "⏳ Posting...", "✅ Posted", "❌ Failed" states — must not include
 * `attachments: []` so existing message attachments (gallery images) are kept.
 */
export function buildReviewLastBatchStatusEdit(
  state: ReviewState,
  statusText: string,
  postedUrl?: string,
): MessageEditOptions {
  const container = buildLastBatchContainer(state);

  if (postedUrl) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel("View Post")
          .setEmoji("🔗")
          .setStyle(ButtonStyle.Link)
          .setURL(postedUrl),
        new ButtonBuilder()
          .setCustomId("review:no-delete")
          .setLabel("Do not delete — images linked here")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      ),
    );
  } else {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("review:status")
          .setLabel(statusText)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      ),
    );
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container] as MessageEditOptions["components"],
    content: null,
    embeds: [],
  } as MessageEditOptions;
}

/**
 * Edit options for the last batch when a review has been skipped.
 * Shows the content/gallery with a disabled "Skipped" label and an active "Undo Skip" button.
 */
export function buildSkippedEdit(
  state: ReviewState,
  reviewId: string,
): MessageEditOptions {
  const SKIPPED_LABEL_ID = "review:skipped-label";
  const container = buildLastBatchContainer(state);

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(SKIPPED_LABEL_ID)
        .setLabel("⏭️ Skipped")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`${REVIEW_UNDO_SKIP_PREFIX}${reviewId}`)
        .setLabel("↩️ Undo Skip")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container] as MessageEditOptions["components"],
    content: null,
    embeds: [],
  } as MessageEditOptions;
}
