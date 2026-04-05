import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import {
  REVIEW_EDIT_PREFIX,
  REVIEW_POST_PREFIX,
  REVIEW_REMOVE_PREFIX,
  REVIEW_SKIP_PREFIX,
  type ReviewState,
} from "../service/review/types";

type ReviewComponent =
  | TextDisplayBuilder
  | MediaGalleryBuilder
  | ActionRowBuilder<StringSelectMenuBuilder>
  | ActionRowBuilder<ButtonBuilder>;

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
  const components: ReviewComponent[] = [];
  const allFileNames = state.fileNames;

  if (chunkIndex === 0) {
    const headerText = state.customContent ?? state.renderedContent;
    components.push(new TextDisplayBuilder().setContent(headerText));
  } else {
    const endIdx = Math.min(startIdx + MAX_ATTACHMENTS_PER_MESSAGE, allFileNames.length);
    components.push(
      new TextDisplayBuilder().setContent(
        `📎 Images ${startIdx + 1}–${endIdx}`
      )
    );
  }

  const gallery = new MediaGalleryBuilder();
  for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE; i++) {
    const globalIdx = startIdx + i;
    if (globalIdx >= allFileNames.length) break;

    const item = new MediaGalleryItemBuilder()
      .setURL(`attachment://${allFileNames[globalIdx]}`)
      .setSpoiler(state.removedIndices.has(globalIdx));
    gallery.addItems(item);
  }
  components.push(gallery);

  return components;
}

function buildControlComponents(
  state: ReviewState,
  reviewId: string,
  startIdx: number,
): ReviewComponent[] {
  const components: ReviewComponent[] = [];
  const allFileNames = state.fileNames;

  if (startIdx === 0) {
    const headerText = state.customContent ?? state.renderedContent;
    components.push(new TextDisplayBuilder().setContent(headerText));
  }

  if (allFileNames.length > 0) {
    const gallery = new MediaGalleryBuilder();
    for (let i = startIdx; i < allFileNames.length; i++) {
      const item = new MediaGalleryItemBuilder()
        .setURL(`attachment://${allFileNames[i]}`)
        .setSpoiler(state.removedIndices.has(i));
      gallery.addItems(item);
    }
    components.push(gallery);
  }

  if (allFileNames.length > 1) {
    const options = allFileNames.map((name, i) => {
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

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`${REVIEW_REMOVE_PREFIX}${reviewId}`)
      .setPlaceholder(`Select images to remove from all ${allFileNames.length} images...`)
      .setMinValues(0)
      .setMaxValues(allFileNames.length)
      .addOptions(options);

    components.push(
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

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      editButton,
      postButton,
      skipButton,
    ),
  );

  return components;
}

function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
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
  };
}

/**
 * Edit a Components V2 review message down to a single status line (posting / posted / error).
 * Must keep {@link MessageFlags.IsComponentsV2} or Discord rejects the edit and the UI can stay stuck.
 */
export function buildReviewStatusEditOptions(statusText: string): MessageEditOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [new TextDisplayBuilder().setContent(statusText)] as MessageEditOptions["components"],
    content: null,
    embeds: [],
    attachments: [],
  } as MessageEditOptions;
}
