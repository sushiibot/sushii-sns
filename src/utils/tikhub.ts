import { recordApiUsage, type ApiUsageEndpointKey } from "../apiUsage";
import logger from "../logger";
import type { File } from "../platforms/base";
import { tracedFetch } from "./http";

const log = logger.child({ module: "tikhub" });

const TIKHUB_BASE_URL = "https://api.tikhub.io";

export class TikHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TikHubError";
  }
}

/**
 * GET a TikHub endpoint and return its `data` payload.
 *
 * TikHub wraps every response as `{ code, message, data, ... }`. A non-200
 * HTTP status or a non-200 `code` is treated as a failure.
 */
export async function tikhubGet(
  path: string,
  params: Record<string, string | undefined>,
  usageKey: ApiUsageEndpointKey,
): Promise<unknown> {
  // Read from env directly (like the other downloaders) so importing this
  // doesn't require the full validated config, e.g. in tests
  const apiKey = process.env.TIKHUB_API_KEY;
  if (!apiKey) {
    throw new TikHubError("TikHub is not configured (missing TIKHUB_API_KEY)");
  }

  const url = new URL(path, TIKHUB_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  const res = await tracedFetch(
    new Request(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
  );
  recordApiUsage(usageKey);

  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (!res.ok || (body?.code !== undefined && body.code !== 200)) {
    log.error(
      { path, params, status: res.status, body: body ?? text.slice(0, 500) },
      "TikHub request failed",
    );

    const detail = body?.detail?.message ?? body?.message ?? body?.detail;
    throw new TikHubError(
      `TikHub ${path} failed (${res.status})${typeof detail === "string" ? `: ${detail}` : ""}`,
      res.status,
    );
  }

  log.debug({ path, params, data: body?.data }, "TikHub response");

  return body?.data;
}

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/**
 * Downloads a media file with an optional Referer (Weibo's CDN rejects
 * hotlinks without one) and infers the extension from the Content-Type.
 */
export async function downloadMedia(
  url: string,
  fallbackExt: string,
  referer?: string,
): Promise<File> {
  const res = await tracedFetch(
    new Request(url, {
      headers: referer ? { Referer: referer } : undefined,
    }),
  );
  if (!res.ok) {
    throw new Error(`Failed to download media (${res.status}): ${url}`);
  }

  const contentType = res.headers.get("content-type")?.split(";")[0].trim();
  const ext = (contentType && CONTENT_TYPE_EXT[contentType]) || fallbackExt;

  return { ext, buffer: Buffer.from(await res.arrayBuffer()) };
}
