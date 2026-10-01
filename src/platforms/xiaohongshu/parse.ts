/**
 * Tolerant extraction of a Xiaohongshu note from TikHub responses.
 *
 * TikHub's XHS endpoints proxy different upstream APIs (app feed vs web feed)
 * whose note objects differ: the app uses `images_list` / `video_info_v2`
 * while the web uses `note_card` / `image_list` / `video.media.stream`. Rather
 * than a strict schema per endpoint, find the note object and pull media out of
 * whichever shape it has.
 */

type Obj = Record<string, any>;

export interface XhsMedia {
  imageUrl?: string;
  // Live photo motion clip, or the video for video notes
  videoUrl?: string;
}

export interface XhsNote {
  noteId?: string;
  username: string;
  title: string;
  desc: string;
  timestamp?: Date;
  media: XhsMedia[];
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MEDIA_KEYS = [
  "images_list",
  "image_list",
  "video",
  "video_info",
  "video_info_v2",
];

function looksLikeNote(o: Obj): boolean {
  return (
    ("desc" in o || "title" in o || "display_title" in o) &&
    MEDIA_KEYS.some((k) => k in o)
  );
}

/** Breadth-first search for the first note-shaped object. */
export function findNote(data: unknown, noteId?: string): Obj | undefined {
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

    const candidate = isObj(cur.note_card) ? cur.note_card : cur;
    if (looksLikeNote(candidate)) {
      const id = candidate.note_id ?? candidate.id ?? cur.id;
      // Web feed endpoints also return recommended notes, so prefer an ID match
      if (!noteId || id === noteId) {
        return candidate;
      }
      firstMatch ??= candidate;
    }

    queue.push(...Object.values(cur));
  }

  return firstMatch;
}

function firstString(...vals: unknown[]): string | undefined {
  return vals.find((v): v is string => typeof v === "string" && v.length > 0);
}

/** Finds the best h264 (then h265) master_url in a `stream` object, recursively. */
export function findStreamUrl(v: unknown, depth = 0): string | undefined {
  if (depth > 6 || v === null || typeof v !== "object") {
    return undefined;
  }

  if (isObj(v) && isObj(v.stream)) {
    for (const codec of ["h264", "h265", "av1", "h266"]) {
      const streams = v.stream[codec];
      if (Array.isArray(streams) && streams.length > 0) {
        const url = firstString(
          streams[0]?.master_url,
          streams[0]?.backup_urls?.[0],
        );
        if (url) {
          return url;
        }
      }
    }
  }

  for (const child of Object.values(v)) {
    const url = findStreamUrl(child, depth + 1);
    if (url) {
      return url;
    }
  }

  return undefined;
}

function imageUrl(img: Obj): string | undefined {
  const infoList: Obj[] = Array.isArray(img.info_list) ? img.info_list : [];
  const dft =
    infoList.find((i) => i.image_scene === "WB_DFT") ??
    infoList.find((i) => i.image_scene === "H5_DTL") ??
    infoList[infoList.length - 1];

  return firstString(
    img.original,
    img.url_size_large,
    img.url_default,
    dft?.url,
    img.url,
    img.url_pre,
  );
}

function livePhotoUrl(img: Obj): string | undefined {
  if (!img.live_photo) {
    return undefined;
  }

  return findStreamUrl(img.live_photo) ?? findStreamUrl(img.stream ? img : {});
}

function videoUrl(note: Obj): string | undefined {
  return (
    findStreamUrl(note.video_info_v2) ??
    findStreamUrl(note.video) ??
    findStreamUrl(note.video_info) ??
    firstString(note.video?.url, note.video_info?.url)
  );
}

function toDate(time: unknown): Date | undefined {
  const n = typeof time === "string" ? Number(time) : time;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return undefined;
  }

  // App returns seconds, web returns milliseconds
  return new Date(n < 1e12 ? n * 1000 : n);
}

export function parseXhsNote(data: unknown, noteId?: string): XhsNote {
  const note = findNote(data, noteId);
  if (!note) {
    throw new Error("No Xiaohongshu note found in response");
  }

  const user: Obj = isObj(note.user) ? note.user : {};
  const images: Obj[] = (
    Array.isArray(note.images_list) ? note.images_list : note.image_list ?? []
  ).filter(isObj);

  const media: XhsMedia[] = [];
  const isVideo = note.type === "video";

  if (isVideo) {
    const url = videoUrl(note);
    if (url) {
      media.push({ videoUrl: url });
    }
  } else {
    for (const img of images) {
      media.push({ imageUrl: imageUrl(img), videoUrl: livePhotoUrl(img) });
    }
  }

  return {
    noteId: firstString(note.note_id, note.id, noteId),
    username:
      firstString(user.nickname, user.nick_name, user.name) ?? "Unknown user",
    title: firstString(note.title, note.display_title) ?? "",
    desc: firstString(note.desc) ?? "",
    timestamp: toDate(note.time ?? note.create_time),
    media,
  };
}
