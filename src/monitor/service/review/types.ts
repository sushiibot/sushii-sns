import type { AnySnsMetadata, PostData } from "../../../platforms/base";

// ---------------------------------------------------------------------------
// Custom ID prefixes (shared between view/ and handlers/)
// ---------------------------------------------------------------------------
export const MONITOR_POLL_PREFIX = "monitor:poll:";
export const REVIEW_REMOVE_PREFIX = "monitor:review:remove:";
export const REVIEW_EDIT_PREFIX = "monitor:review:edit:";
export const REVIEW_MODAL_PREFIX = "monitor:review:modal:";
export const REVIEW_POST_PREFIX = "monitor:review:post:";
export const REVIEW_SKIP_PREFIX = "monitor:review:skip:";
export const REVIEW_UNDO_SKIP_PREFIX = "monitor:review:undo-skip:";

export interface ReviewState {
  postData: PostData<AnySnsMetadata>;
  guildId: string;
  connectionId: string;
  removedIndices: Set<number>;
  customContent: string | null;
  renderedContent: string;
  socialsChannelId: string;
  format: "links" | "inline";
  template: string;
  fetcherUserId: string;
  fileNames: string[];
  messageIds: string[];
  cdnUrls: string[];  // indexed by file position; populated after review messages are sent
}
