/**
 * Tracks outbound API calls per provider and per endpoint for `/usage` slash commands.
 * Fill in `quotaHint` per endpoint with your plan limit text (shown as USED / quotaHint).
 */

export type ApiProviderId =
  | "fxtwitter"
  | "rapidapi"
  | "brightdata"
  | "tikhub";

/** Stable keys for each counted HTTP call — use with recordApiUsage() */
export const ApiUsageEndpoint = {
  FXTWITTER_STATUS: "fxtwitter_status",
  RAPIDAPI_IG_BEST_EXPERIENCE_POST: "rapidapi_ig_best_experience_post",
  RAPIDAPI_IG_BEST_EXPERIENCE_PROFILE: "rapidapi_ig_best_experience_profile",
  RAPIDAPI_IG_BEST_EXPERIENCE_STORIES: "rapidapi_ig_best_experience_stories",
  RAPIDAPI_IG_BEST_EXPERIENCE_FEED: "rapidapi_ig_best_experience_feed",
  RAPIDAPI_IG_LOOTER_POST: "rapidapi_ig_looter_post",
  RAPIDAPI_IG_SCRAPER_API2_POST: "rapidapi_ig_scraper_api2_post",
  RAPIDAPI_IG_SCRAPER_API2_STORIES: "rapidapi_ig_scraper_api2_stories",
  RAPIDAPI_IG_SCRAPER_API2_POSTS: "rapidapi_ig_scraper_api2_posts",
  RAPIDAPI_TIKTOK_BEST_VIDEO: "rapidapi_tiktok_best_video",
  RAPIDAPI_TIKTOK_BEST_USER_FEED: "rapidapi_tiktok_best_user_feed",
  RAPIDAPI_TIKTOK_API6_USER_VIDEOS: "rapidapi_tiktok_api6_user_videos",
  RAPIDAPI_TWITTER45_TIMELINE: "rapidapi_twitter45_timeline",
  BRIGHTDATA_TRIGGER: "brightdata_trigger",
  BRIGHTDATA_PROGRESS: "brightdata_progress",
  BRIGHTDATA_SNAPSHOT: "brightdata_snapshot",
  TIKHUB_XHS_APP_NOTE_INFO: "tikhub_xhs_app_note_info",
  TIKHUB_XHS_WEB_NOTE_INFO_V7: "tikhub_xhs_web_note_info_v7",
  TIKHUB_WEIBO_WEB_V2_POST_DETAIL: "tikhub_weibo_web_v2_post_detail",
  TIKHUB_WEIBO_APP_STATUS_DETAIL: "tikhub_weibo_app_status_detail",
} as const;

export type ApiUsageEndpointKey =
  (typeof ApiUsageEndpoint)[keyof typeof ApiUsageEndpoint];

type EndpointMeta = {
  provider: ApiProviderId;
  label: string;
  /** Shown after the slash: `(used / <quotaHint>)` — set your real quota text here */
  quotaHint: string;
};

const ENDPOINT_META: Record<ApiUsageEndpointKey, EndpointMeta> = {
  [ApiUsageEndpoint.FXTWITTER_STATUS]: {
    provider: "fxtwitter",
    label: "fxtwitter — GET status",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_IG_BEST_EXPERIENCE_POST]: {
    provider: "rapidapi",
    label: "instagram-best-experience — GET post",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_IG_BEST_EXPERIENCE_PROFILE]: {
    provider: "rapidapi",
    label: "instagram-best-experience — GET profile",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_IG_BEST_EXPERIENCE_STORIES]: {
    provider: "rapidapi",
    label: "instagram-best-experience — GET stories",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_IG_BEST_EXPERIENCE_FEED]: {
    provider: "rapidapi",
    label: "instagram-best-experience — GET feed",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_IG_LOOTER_POST]: {
    provider: "rapidapi",
    label: "instagram-looter2 — GET post",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_IG_SCRAPER_API2_POST]: {
    provider: "rapidapi",
    label: "instagram-scraper-api2 — GET post_info",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_IG_SCRAPER_API2_STORIES]: {
    provider: "rapidapi",
    label: "instagram-scraper-api2 — GET stories",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_IG_SCRAPER_API2_POSTS]: {
    provider: "rapidapi",
    label: "instagram-scraper-api2 — GET posts",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_TIKTOK_BEST_VIDEO]: {
    provider: "rapidapi",
    label: "tiktok-best-experience — GET video",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_TIKTOK_BEST_USER_FEED]: {
    provider: "rapidapi",
    label: "tiktok-best-experience — GET user/feed",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_TIKTOK_API6_USER_VIDEOS]: {
    provider: "rapidapi",
    label: "tiktok-api6 — GET user/videos",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.RAPIDAPI_TWITTER45_TIMELINE]: {
    provider: "rapidapi",
    label: "twitter-api45 — GET timeline",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.BRIGHTDATA_TRIGGER]: {
    provider: "brightdata",
    label: "Bright Data — POST trigger",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.BRIGHTDATA_PROGRESS]: {
    provider: "brightdata",
    label: "Bright Data — GET progress (each poll)",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.BRIGHTDATA_SNAPSHOT]: {
    provider: "brightdata",
    label: "Bright Data — GET snapshot",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.TIKHUB_XHS_APP_NOTE_INFO]: {
    provider: "tikhub",
    label: "TikHub — xiaohongshu app get_note_info",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.TIKHUB_XHS_WEB_NOTE_INFO_V7]: {
    provider: "tikhub",
    label: "TikHub — xiaohongshu web get_note_info_v7",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.TIKHUB_WEIBO_WEB_V2_POST_DETAIL]: {
    provider: "tikhub",
    label: "TikHub — weibo web_v2 fetch_post_detail",
    quotaHint: "—",
  },
  [ApiUsageEndpoint.TIKHUB_WEIBO_APP_STATUS_DETAIL]: {
    provider: "tikhub",
    label: "TikHub — weibo app fetch_status_detail",
    quotaHint: "—",
  },
};

/** Per-provider total quota hint for `/usage providers` — edit to match your plans */
export const PROVIDER_QUOTA_HINT: Record<ApiProviderId, string> = {
  fxtwitter: "—",
  rapidapi: "—",
  brightdata: "—",
  tikhub: "—",
};

const counts = new Map<ApiUsageEndpointKey, number>();

export function recordApiUsage(key: ApiUsageEndpointKey, delta = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + delta);
}

export function getEndpointCount(key: ApiUsageEndpointKey): number {
  return counts.get(key) ?? 0;
}

export function getProviderTotals(): Record<ApiProviderId, number> {
  const totals: Record<ApiProviderId, number> = {
    fxtwitter: 0,
    rapidapi: 0,
    brightdata: 0,
    tikhub: 0,
  };
  for (const [key, n] of counts) {
    totals[ENDPOINT_META[key].provider] += n;
  }
  return totals;
}

function formatLine(used: number, quotaHint: string): string {
  return `${used} / ${quotaHint}`;
}

/** Discord message chunk (max ~2000); providers summary */
export function formatUsageProvidersMessage(): string {
  const totals = getProviderTotals();
  const lines = [
    "**API usage by provider** (calls this process lifetime)",
    "",
    `- **fxtwitter**: ${formatLine(totals.fxtwitter, PROVIDER_QUOTA_HINT.fxtwitter)}`,
    `- **rapidapi**: ${formatLine(totals.rapidapi, PROVIDER_QUOTA_HINT.rapidapi)}`,
    `- **brightdata**: ${formatLine(totals.brightdata, PROVIDER_QUOTA_HINT.brightdata)}`,
    `- **tikhub**: ${formatLine(totals.tikhub, PROVIDER_QUOTA_HINT.tikhub)}`,
  ];
  return lines.join("\n");
}

/** Per-endpoint lines */
export function formatUsageEndpointsMessage(): string {
  const lines: string[] = [
    "**API usage by endpoint** (calls this process lifetime)",
    "",
  ];
  const keys = Object.keys(ENDPOINT_META) as ApiUsageEndpointKey[];
  keys.sort((a, b) => ENDPOINT_META[a].label.localeCompare(ENDPOINT_META[b].label));
  for (const key of keys) {
    const meta = ENDPOINT_META[key];
    const used = getEndpointCount(key);
    lines.push(`- **${meta.label}**: ${formatLine(used, meta.quotaHint)}`);
  }
  return lines.join("\n");
}

export function formatUsageAllMessage(): string {
  return `${formatUsageProvidersMessage()}\n\n${formatUsageEndpointsMessage()}`;
}
