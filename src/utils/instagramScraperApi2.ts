import logger from "../logger";
import { ApiUsageEndpoint, recordApiUsage, type ApiUsageEndpointKey } from "../apiUsage";
import { parseJsonPreservingBigIntKeys, tracedFetch } from "./http";

const log = logger.child({ module: "instagramScraperApi2" });

const HOST = "instagram-scraper-api2.p.rapidapi.com";

type Resource = { url?: string; width?: number; height?: number };

function sortLargestFirst<T extends Resource>(resources: unknown): T[] {
  if (!Array.isArray(resources)) {
    return [];
  }
  return [...resources].sort(
    (a, b) => (b?.width ?? 0) * (b?.height ?? 0) - (a?.width ?? 0) * (a?.height ?? 0),
  );
}

/**
 * Maps a scraper-api2 media item (post, carousel slide, story, feed item) onto
 * the instagram-best-experience shape so existing parsers can consume it.
 * Candidates are sorted largest-first because callers take index 0.
 */
export function normalizeScraperApi2Media(item: any): any {
  if (!item || typeof item !== "object") {
    return item;
  }

  const normalized: any = {
    ...item,
    image_versions2: { candidates: sortLargestFirst(item.image_versions?.items) },
    video_versions: sortLargestFirst(item.video_versions),
  };

  if (Array.isArray(item.carousel_media)) {
    normalized.carousel_media = item.carousel_media.map(normalizeScraperApi2Media);
  }

  return normalized;
}

/**
 * Story `id` here is the bare media pk; best-experience uses "{media_pk}_{owner_pk}".
 * Match that so monitor seen-state keys stay identical across providers.
 */
export function normalizeScraperApi2Story(item: any): any {
  const normalized = normalizeScraperApi2Media(item);
  const mediaPk = String(item?.pk ?? item?.id ?? "").split("_")[0];
  const ownerPk = item?.user?.id ?? item?.owner?.id;

  normalized.pk = mediaPk;
  if (mediaPk && ownerPk) {
    normalized.id = `${mediaPk}_${ownerPk}`;
  }

  return normalized;
}

async function scraperApi2Get(
  path: string,
  params: Record<string, string>,
  endpoint: ApiUsageEndpointKey,
  apiKey: string,
): Promise<any> {
  const url = `https://${HOST}/v1/${path}?${new URLSearchParams(params)}`;
  const res = await tracedFetch(
    new Request(url, {
      method: "GET",
      headers: { "x-rapidapi-host": HOST, "x-rapidapi-key": apiKey },
    }),
  );
  recordApiUsage(endpoint);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.warn(
      { provider: "instagram-scraper-api2", status: res.status, body, url },
      `instagram-scraper-api2 /${path} failed`,
    );
    throw new Error(`instagram-scraper-api2 /${path} failed (${res.status})`);
  }

  const json: any = parseJsonPreservingBigIntKeys(await res.text(), ["pk", "id"]);
  if (!json?.data) {
    throw new Error(`instagram-scraper-api2 /${path} returned no data`);
  }
  return json.data;
}

export async function fetchPostViaScraperApi2(shortcode: string, apiKey: string): Promise<any> {
  const data = await scraperApi2Get(
    "post_info",
    { code_or_id_or_url: shortcode },
    ApiUsageEndpoint.RAPIDAPI_IG_SCRAPER_API2_POST,
    apiKey,
  );
  return normalizeScraperApi2Media(data);
}

export async function fetchStoriesViaScraperApi2(username: string, apiKey: string): Promise<any[]> {
  const data = await scraperApi2Get(
    "stories",
    { username_or_id_or_url: username },
    ApiUsageEndpoint.RAPIDAPI_IG_SCRAPER_API2_STORIES,
    apiKey,
  );
  return Array.isArray(data.items) ? data.items.map(normalizeScraperApi2Story) : [];
}

export async function fetchUserPostsViaScraperApi2(username: string, apiKey: string): Promise<any[]> {
  const data = await scraperApi2Get(
    "posts",
    { username_or_id_or_url: username },
    ApiUsageEndpoint.RAPIDAPI_IG_SCRAPER_API2_POSTS,
    apiKey,
  );
  return Array.isArray(data.items) ? data.items.map(normalizeScraperApi2Media) : [];
}
