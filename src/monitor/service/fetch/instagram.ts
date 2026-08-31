/**
 * Instagram profile feed: RapidAPI list + hydrate to PostData (no DB / seen state).
 */
import { ApiUsageEndpoint, recordApiUsage } from "../../../apiUsage";
import config from "../../../config/config";
import logger from "../../../logger";
import type { AnySnsMetadata, InstagramMetadata, PostData } from "../../../platforms/base";
import { resolveInstagramUserId } from "../../../utils/instagramBestExperience";
import { tryWithFallbacks } from "../../../utils/fallback";
import { isDevMode, loadMockJson } from "../../runtime";
import type { DownloadFilesFromUrls } from "../fetch";
import { fetchInstagramStories } from "./instagram-story";

const log = logger.child({ module: "monitor/fetch/instagram" });

async function extractErrorBody(res: Response): Promise<string | object> {
  try {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch { return "<unreadable>"; }
}

/**
 * Normalized post node from RapidAPI /posts or Looter feed.
 */
interface NormalizedFeedNode {
  shortcode: string;
  /** True when the carousel media URLs are not available inline and must be fetched via API. */
  needsCarouselApiFetch: boolean;
  meta: {
    title: string;
    sourceUrl: string;
    shortcode: string;
    username: string | undefined;
    takenAt: number | undefined;
  };
  singleMediaUrl?: string;
  isVideo?: boolean;
  carouselUrls?: string[];
}

function parseRapidApiPostsResponse(json: any): NormalizedFeedNode[] {
  let rawNodes: any[] | undefined;

  if (Array.isArray(json)) {
    rawNodes = json;
  } else if (Array.isArray(json?.data)) {
    rawNodes = json.data;
  } else if (Array.isArray(json?.result)) {
    rawNodes = json.result;
  } else if (Array.isArray(json?.result?.edges)) {
    rawNodes = json.result.edges.map((e: any) => e.node ?? e);
  } else if (Array.isArray(json?.items)) {
    rawNodes = json.items;
  }

  if (!rawNodes) {
    throw new Error("instagram-best-experience /feed returned unexpected response format");
  }

  if (rawNodes.length > 0 && rawNodes[0].urls) {
    log.warn("instagram-best-experience /feed returned pre-flattened items — carousel detection unavailable");
    return rawNodes.flatMap((item: any) => {
      const shortcode = item.meta?.shortcode;
      if (!shortcode) return [];
      const url = item.urls?.[0]?.url;
      if (!url) return [];
      return [{
        shortcode,
        needsCarouselApiFetch: false,
        meta: item.meta,
        singleMediaUrl: url,
        isVideo: item.urls?.[0]?.extension === "mp4",
      }];
    });
  }

  const findMediaUrl = (obj: any): string | undefined =>
    obj?.video_url ??
    obj?.display_url ??
    obj?.thumbnail_src ??
    obj?.image_versions2?.candidates?.[0]?.url ??
    obj?.thumbnail_resources?.[obj.thumbnail_resources?.length - 1]?.src;

  const nodes: NormalizedFeedNode[] = [];

  for (const node of rawNodes) {
    const shortcode = node.shortcode ?? node.code;
    if (!shortcode) continue;

    const meta = {
      title:
        node.edge_media_to_caption?.edges?.[0]?.node?.text ??
        node.caption?.text ??
        "",
      sourceUrl: `https://www.instagram.com/p/${shortcode}/`,
      shortcode,
      username: node.owner?.username ?? node.user?.username,
      takenAt: node.taken_at_timestamp ?? node.taken_at ?? node.device_timestamp,
    };

    if (
      node?.media_type === 8 ||
      node?.product_type === "carousel_container" ||
      !!node?.edge_sidecar_to_children ||
      !!node?.carousel_media
    ) {
      if (Array.isArray(node.carousel_media) && node.carousel_media.length > 0) {
        const carouselUrls = node.carousel_media
          .map((slide: any) => {
            const videoUrl = Array.isArray(slide.video_versions) && slide.video_versions.length > 0
              ? slide.video_versions[0]?.url
              : undefined;
            const imageUrl = slide.image_versions2?.candidates?.[0]?.url;
            return videoUrl ?? imageUrl;
          })
          .filter((u: unknown): u is string => typeof u === "string" && u.length > 0);

        if (carouselUrls.length > 0) {
          log.debug({ shortcode, slideCount: carouselUrls.length }, "Extracted carousel slides from feed inline");
          nodes.push({ shortcode, needsCarouselApiFetch: false, meta, carouselUrls });
          continue;
        }
      }

      log.debug({ shortcode }, "Carousel has no inline media — will fetch via mediaByShortcode");
      nodes.push({ shortcode, needsCarouselApiFetch: true, meta });
      continue;
    }

    const mediaUrl = findMediaUrl(node);
    if (!mediaUrl) {
      log.warn({ shortcode, nodeKeys: Object.keys(node) }, "Could not find media URL in node, skipping");
      continue;
    }

    nodes.push({
      shortcode,
      needsCarouselApiFetch: false,
      meta,
      singleMediaUrl: mediaUrl,
      isVideo: node.is_video === true || node.media_type === 2,
    });
  }

  return nodes;
}

/**
 * List-only: instagram-best-experience /feed → normalized feed nodes.
 */
async function listIgProfilePostsViaBestExperience(
  igUsername: string,
  userId?: string,
): Promise<NormalizedFeedNode[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("instagram-post-rapidapi.json");
    return parseRapidApiPostsResponse(mock);
  }

  const resolvedUserId = userId ?? await resolveInstagramUserId(igUsername, config.RAPID_API_KEY);

  const req = new Request(
    `https://instagram-best-experience.p.rapidapi.com/feed?user_id=${resolvedUserId}`,
    {
      method: "GET",
      headers: {
        "x-rapidapi-host": "instagram-best-experience.p.rapidapi.com",
        "x-rapidapi-key": config.RAPID_API_KEY,
      },
    },
  );

  const res = await fetch(req);
  recordApiUsage(ApiUsageEndpoint.RAPIDAPI_IG_BEST_EXPERIENCE_FEED);
  if (!res.ok) {
    const errorBody = await extractErrorBody(res);
    log.error(
      {
        status: res.status,
        statusText: res.statusText,
        errorBody,
        url: req.url,
      },
      "instagram-best-experience /feed failed",
    );
    throw new Error(
      `instagram-best-experience /feed failed: ${res.status} ${res.statusText} - ${typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody)}`,
    );
  }

  const rawJson = await res.json();
  const items = Array.isArray(rawJson?.items) ? rawJson.items : rawJson;
  return parseRapidApiPostsResponse(items);
}

/**
 * Download media for one feed node and build PostData (no seen state).
 */
async function hydrateIgFeedNode(
  node: NormalizedFeedNode,
  igUsername: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
): Promise<PostData<InstagramMetadata> | null> {
  const { shortcode, meta } = node;

  const postUrl = meta.sourceUrl ?? `https://www.instagram.com/p/${shortcode}/`;

  let mediaUrls: string[];

  if (node.carouselUrls?.length) {
    mediaUrls = node.carouselUrls;
  } else if (node.singleMediaUrl) {
    mediaUrls = [node.singleMediaUrl];
  } else {
    if (node.needsCarouselApiFetch) {
      log.error({ shortcode, node }, "Carousel flagged but no URLs - unexpected RapidAPI response");
    }
    return null;
  }

  if (mediaUrls.length === 0) return null;

  const files = await downloadFilesFromUrls(mediaUrls);

  return {
    postLink: {
      url: postUrl,
      metadata: { platform: "instagram" as const, shortcode },
    },
    username: meta.username || igUsername,
    postID: shortcode,
    originalText: meta.title || "",
    timestamp: meta.takenAt ? new Date(meta.takenAt * 1000) : undefined,
    files,
  };
}

async function orchestrateIgProfileNodes(
  nodes: NormalizedFeedNode[],
  igUsername: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
    markSeenOnly?: boolean;
  },
): Promise<PostData<InstagramMetadata>[]> {
  const limit = options?.limit ?? Infinity;
  const seenChecker = options?.isPostSeen;
  const markSeen = options?.markPostSeen;

  const unseenNodes = nodes.filter((n) => !seenChecker?.(n.shortcode));
  const nodesToProcess = limit > 0 && isFinite(limit) ? unseenNodes.slice(0, limit) : unseenNodes;

  // Mark-seen-only mode: record all unseen IDs without downloading media.
  if (options?.markSeenOnly) {
    for (const node of nodesToProcess) {
      markSeen?.(node.shortcode);
    }
    return [];
  }

  const postDatas: PostData<InstagramMetadata>[] = [];
  const shortcodesToMarkSeen: string[] = [];

  for (const node of nodesToProcess) {
    const p = await hydrateIgFeedNode(node, igUsername, downloadFilesFromUrls);
    if (p) {
      postDatas.push(p);
      shortcodesToMarkSeen.push(node.shortcode);
    } else {
      log.warn(
        { shortcode: node.shortcode },
        "IG profile post hydration returned null; marking seen to avoid infinite retry",
      );
      shortcodesToMarkSeen.push(node.shortcode); // still mark seen
    }
  }

  // Only mark posts seen after ALL hydration succeeds, so that if this
  // provider throws mid-way and tryWithFallbacks retries with another
  // provider, the fallback can still see those posts as unseen.
  for (const shortcode of shortcodesToMarkSeen) {
    markSeen?.(shortcode);
  }

  return postDatas;
}

/**
 * Fetch Instagram profile posts with fallbacks (orchestrator: filter + mark + hydrate).
 */
async function fetchIgProfilePosts(
  igUsername: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
    markSeenOnly?: boolean;
  },
  userId?: string,
): Promise<PostData<InstagramMetadata>[]> {
  return tryWithFallbacks([
    {
      name: "instagram-best-experience /feed",
      fn: async () => {
        const nodes = await listIgProfilePostsViaBestExperience(igUsername, userId);
        return orchestrateIgProfileNodes(nodes, igUsername, downloadFilesFromUrls, options);
      },
    },
  ]);
}

/**
 * Seed: list current profile posts, mark all as seen, return count.
 * No media downloaded. Profile name not available from this API — returns null.
 */
export async function seedIgProfileFeed(
  handle: string,
  isPostSeen: (id: string) => boolean,
  markPostSeen: (id: string) => void,
): Promise<{ count: number; profileName: string | null }> {
  const nodes = await listIgProfilePostsViaBestExperience(handle);
  const unseen = nodes.filter((n) => !isPostSeen(n.shortcode));
  for (const n of unseen) {
    markPostSeen(n.shortcode);
  }
  return { count: unseen.length, profileName: null };
}

export async function fetchInstagramConnectionPosts(
  igUsername: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
    storiesLimit?: number;
    storiesMarkSeenOnly?: boolean;
    profileMarkSeenOnly?: boolean;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const profileOptions = options
    ? { ...options, markSeenOnly: options.profileMarkSeenOnly }
    : undefined;

  // Resolve once and share between profile + stories fetches to avoid
  // doubling /profile RapidAPI usage on every poll tick. Falls through to
  // undefined on failure — each fetch still resolves its own userId then.
  const userId = await resolveInstagramUserId(igUsername, config.RAPID_API_KEY).catch(
    (err) => {
      log.warn({ err, igUsername }, "Failed to pre-resolve Instagram user ID; falling back to per-call resolution");
      return undefined;
    },
  );

  const [profileResult, storiesResult] = await Promise.allSettled([
    fetchIgProfilePosts(igUsername, downloadFilesFromUrls, profileOptions, userId),
    fetchInstagramStories(igUsername, downloadFilesFromUrls, options, userId),
  ]);

  const profilePosts = profileResult.status === "fulfilled" ? profileResult.value : [];
  const stories = storiesResult.status === "fulfilled" ? storiesResult.value : [];

  if (profileResult.status === "rejected") {
    log.error({ err: profileResult.reason }, "Failed to fetch Instagram profile posts");
  }
  if (storiesResult.status === "rejected") {
    log.error({ err: storiesResult.reason }, "Failed to fetch Instagram stories");
  }

  return [...profilePosts, ...stories] as PostData<AnySnsMetadata>[];
}