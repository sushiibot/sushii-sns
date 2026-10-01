/**
 * Tolerant extraction of a Weibo status from TikHub responses.
 *
 * web_v2 proxies weibo.com's `ajax/statuses/show` (pic_ids/pic_infos,
 * mix_media_info, page_info.media_info) while the app endpoint returns the
 * mobile shape (pics[], page_info.urls). Both are handled here.
 */

type Obj = Record<string, any>;

export interface WeiboMedia {
  url: string;
  kind: "image" | "video";
}

export interface WeiboPost {
  postId: string;
  username: string;
  text: string;
  timestamp?: Date;
  media: WeiboMedia[];
}

const BASE62 =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Converts a base62 Weibo bid (e.g. from weibo.com/{uid}/{bid}) to the numeric
 * mid. The bid is decoded in 4-char groups from the right, each group becoming
 * 7 decimal digits (zero-padded except the leftmost).
 */
export function bidToMid(bid: string): string {
  const parts: string[] = [];
  for (let end = bid.length; end > 0; end -= 4) {
    const chunk = bid.slice(Math.max(0, end - 4), end);
    let n = 0;
    for (const ch of chunk) {
      const v = BASE62.indexOf(ch);
      if (v < 0) {
        throw new Error(`Invalid Weibo bid: ${bid}`);
      }
      n = n * 62 + v;
    }
    const s = String(n);
    parts.unshift(end - 4 > 0 ? s.padStart(7, "0") : s);
  }
  return parts.join("");
}

/** Inverse of bidToMid, used for tests. */
export function midToBid(mid: string): string {
  const parts: string[] = [];
  for (let end = mid.length; end > 0; end -= 7) {
    let n = Number(mid.slice(Math.max(0, end - 7), end));
    let s = "";
    do {
      s = BASE62[n % 62] + s;
      n = Math.floor(n / 62);
    } while (n > 0);
    parts.unshift(end - 7 > 0 ? s.padStart(4, "0") : s);
  }
  return parts.join("");
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstString(...vals: unknown[]): string | undefined {
  return vals.find((v): v is string => typeof v === "string" && v.length > 0);
}

function looksLikeStatus(o: Obj): boolean {
  return (
    ("text" in o || "text_raw" in o) &&
    isObj(o.user) &&
    ("mid" in o || "idstr" in o || "id" in o)
  );
}

/** Breadth-first search for the status object, preferring a mid match. */
export function findStatus(data: unknown, mid?: string): Obj | undefined {
  const queue: unknown[] = [data];
  let firstMatch: Obj | undefined;

  while (queue.length > 0) {
    const cur = queue.shift();
    if (Array.isArray(cur)) {
      queue.push(...cur);
      continue;
    }
    if (!isObj(cur)) {
      continue;
    }

    if (looksLikeStatus(cur)) {
      const ids = [cur.mid, cur.idstr, cur.id].map((v) => String(v));
      if (!mid || ids.includes(mid)) {
        return cur;
      }
      firstMatch ??= cur;
    }

    queue.push(...Object.values(cur));
  }

  return firstMatch;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""),
  ).trim();
}

function statusText(status: Obj): string {
  const long = firstString(
    status.longTextContent,
    status.longText?.longTextContent,
    status.long_text,
  );
  if (long) {
    return long.includes("<") ? htmlToText(long) : long.trim();
  }

  const raw = firstString(status.text_raw);
  if (raw) {
    return raw.trim();
  }

  return htmlToText(firstString(status.text) ?? "");
}

function picUrl(pic: Obj): string | undefined {
  return firstString(
    pic.largest?.url,
    pic.mw2000?.url,
    pic.original?.url,
    pic.large?.url,
    pic.url,
  );
}

function livePhotoUrl(pic: Obj): string | undefined {
  return firstString(pic.video, pic.videoSrc);
}

/** Highest-resolution video URL from a page_info / media_info object. */
export function videoUrl(pageInfo: Obj): string | undefined {
  const info: Obj = isObj(pageInfo.media_info) ? pageInfo.media_info : {};

  const playback: Obj[] = Array.isArray(info.playback_list)
    ? info.playback_list.filter((p: unknown) => isObj(p) && isObj((p as Obj).play_info))
    : [];
  const best = playback
    .map((p) => p.play_info as Obj)
    .filter((p) => typeof p.url === "string")
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];

  const urls: Obj = isObj(pageInfo.urls) ? pageInfo.urls : {};

  return firstString(
    best?.url,
    info.mp4_720p_mp4,
    info.mp4_hd_url,
    info.mp4_sd_url,
    info.stream_url_hd,
    info.stream_url,
    urls.mp4_720p_mp4,
    urls.mp4_hd_mp4,
    urls.mp4_ld_mp4,
  );
}

function pushPic(media: WeiboMedia[], pic: Obj) {
  const url = picUrl(pic);
  if (url) {
    media.push({ url, kind: "image" });
  }
  const live = livePhotoUrl(pic);
  if (live) {
    media.push({ url: live, kind: "video" });
  }
}

function statusMedia(status: Obj): WeiboMedia[] {
  const media: WeiboMedia[] = [];

  const mixItems = status.mix_media_info?.items;
  if (Array.isArray(mixItems) && mixItems.length > 0) {
    for (const item of mixItems) {
      if (!isObj(item?.data)) {
        continue;
      }
      if (item.type === "video") {
        const url = videoUrl(item.data);
        if (url) {
          media.push({ url, kind: "video" });
        }
      } else {
        pushPic(media, item.data);
      }
    }
    return media;
  }

  if (Array.isArray(status.pic_ids) && isObj(status.pic_infos)) {
    for (const id of status.pic_ids) {
      const pic = status.pic_infos[id];
      if (isObj(pic)) {
        pushPic(media, pic);
      }
    }
  } else if (Array.isArray(status.pics)) {
    for (const pic of status.pics) {
      if (isObj(pic)) {
        pushPic(media, pic);
      }
    }
  }

  const pageInfo = status.page_info;
  if (
    isObj(pageInfo) &&
    (pageInfo.object_type === "video" || pageInfo.type === "video" || isObj(pageInfo.media_info))
  ) {
    const url = videoUrl(pageInfo);
    if (url) {
      media.push({ url, kind: "video" });
    }
  }

  return media;
}

function toDate(createdAt: unknown): Date | undefined {
  if (typeof createdAt !== "string" && typeof createdAt !== "number") {
    return undefined;
  }
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseWeiboPost(data: unknown, mid?: string): WeiboPost {
  const status = findStatus(data, mid);
  if (!status) {
    throw new Error("No Weibo post found in response");
  }

  let text = statusText(status);
  let media = statusMedia(status);

  // Reposts: media lives on the original post
  const rt = status.retweeted_status;
  if (isObj(rt)) {
    const rtUser = firstString(rt.user?.screen_name) ?? "unknown";
    text += `\n\n> RT @${rtUser}: ${statusText(rt).replace(/\n/g, "\n> ")}`;
    if (media.length === 0) {
      media = statusMedia(rt);
    }
  }

  return {
    postId:
      firstString(status.mblogid, status.bid, status.mid, status.idstr) ??
      mid ??
      "unknown",
    username: firstString(status.user?.screen_name) ?? "Unknown user",
    text: text.trim(),
    timestamp: toDate(status.created_at),
    media,
  };
}
