import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { XiaohongshuDownloader } from "./downloader";
import { parseXhsNote } from "./parse";

const dl = new XiaohongshuDownloader();
const NOTE_ID = "665f95200000000006005624";

describe("XiaohongshuDownloader.findUrls", () => {
  it("matches an explore URL with xsec_token", () => {
    const links = dl.findUrls(
      `dl https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=ABC123=&xsec_source=pc_feed`,
    );
    expect(links).toHaveLength(1);
    expect(links[0].metadata).toEqual({
      platform: "xiaohongshu",
      noteId: NOTE_ID,
    });
    expect(links[0].url).toContain("xsec_token=ABC123=");
  });

  it("matches discovery/item and user/profile URLs", () => {
    const links = dl.findUrls(
      `dl https://www.xiaohongshu.com/discovery/item/${NOTE_ID} https://xiaohongshu.com/user/profile/5c2f338a000000000701e1c6/${NOTE_ID}`,
    );
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.metadata.noteId)).toEqual([NOTE_ID, NOTE_ID]);
  });

  it("matches xhslink short links without a note ID", () => {
    const links = dl.findUrls("dl http://xhslink.com/a/EZ4M9TwMA6c3");
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("http://xhslink.com/a/EZ4M9TwMA6c3");
    expect(links[0].metadata.noteId).toBeUndefined();
  });

  it("does not match profile pages or other sites", () => {
    expect(
      dl.findUrls(
        "dl https://www.xiaohongshu.com/user/profile/5c2f338a000000000701e1c6 https://x.com/a/status/1",
      ),
    ).toHaveLength(0);
  });
});

// Web feed shape (note_card / image_list / video.media.stream), along with a
// recommended note that must not be picked
const webImageResponse = {
  data: {
    items: [
      {
        id: "000000000000000000000000",
        note_card: {
          type: "normal",
          title: "wrong note",
          desc: "",
          user: { nickname: "other" },
          image_list: [{ url_default: "https://cdn/other.jpg" }],
        },
      },
      {
        id: NOTE_ID,
        model_type: "note",
        note_card: {
          note_id: NOTE_ID,
          type: "normal",
          title: "제니 ✨",
          desc: "caption #tag",
          time: 1717540128000,
          user: { nickname: "jennierubyjane", user_id: "u1" },
          image_list: [
            {
              url_default: "https://cdn/1_default.webp",
              info_list: [{ image_scene: "WB_DFT", url: "https://cdn/1_dft.webp" }],
            },
            {
              url_default: "https://cdn/2_default.webp",
              live_photo: true,
              stream: { h264: [{ master_url: "https://cdn/2_live.mp4" }] },
            },
          ],
        },
      },
    ],
  },
};

// App feed shape (data[].note_list[], images_list, video_info_v2, seconds)
const appVideoResponse = {
  data: [
    {
      note_list: [
        {
          id: NOTE_ID,
          type: "video",
          title: "",
          desc: "video desc",
          time: 1717540128,
          user: { nickname: "rosie" },
          images_list: [{ url: "https://cdn/cover.jpg" }],
          video_info_v2: {
            media: {
              stream: {
                h265: [{ master_url: "https://cdn/v.h265.mp4" }],
                h264: [{ master_url: "https://cdn/v.h264.mp4" }],
              },
            },
          },
        },
      ],
    },
  ],
};

describe("parseXhsNote", () => {
  it("parses the web shape and picks the matching note", () => {
    const note = parseXhsNote(webImageResponse, NOTE_ID);
    expect(note.username).toBe("jennierubyjane");
    expect(note.title).toBe("제니 ✨");
    expect(note.desc).toBe("caption #tag");
    expect(note.timestamp?.getTime()).toBe(1717540128000);
    expect(note.media).toEqual([
      { imageUrl: "https://cdn/1_default.webp", videoUrl: undefined },
      { imageUrl: "https://cdn/2_default.webp", videoUrl: "https://cdn/2_live.mp4" },
    ]);
  });

  it("parses the app video shape, preferring h264 and converting seconds", () => {
    const note = parseXhsNote(appVideoResponse, NOTE_ID);
    expect(note.username).toBe("rosie");
    expect(note.timestamp?.getTime()).toBe(1717540128000);
    expect(note.media).toEqual([{ videoUrl: "https://cdn/v.h264.mp4" }]);
  });

  it("prefers original over smaller app image variants", () => {
    const note = parseXhsNote({
      note_list: [
        {
          type: "normal",
          desc: "",
          user: { nickname: "a" },
          images_list: [{ url: "https://cdn/small.jpg", original: "https://cdn/orig.jpg" }],
        },
      ],
    });
    expect(note.media[0].imageUrl).toBe("https://cdn/orig.jpg");
  });

  it("throws when there is no note", () => {
    expect(() => parseXhsNote({ data: {} })).toThrow();
  });
});

describe("XiaohongshuDownloader.fetchContent", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TIKHUB_API_KEY;
  let requests: Request[];

  beforeEach(() => {
    process.env.TIKHUB_API_KEY = "test-key";
    requests = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.TIKHUB_API_KEY = originalKey;
  });

  it("falls back to the next endpoint and downloads media", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const req = input as Request;
      requests.push(req);
      const url = new URL(req.url);

      if (url.pathname.endsWith("/app/get_note_info")) {
        return Response.json({ code: 400, message: "boom" }, { status: 400 });
      }
      if (url.pathname.endsWith("/web/get_note_info_v7")) {
        return Response.json({ code: 200, data: webImageResponse });
      }
      return new Response("bytes", {
        headers: {
          "content-type": url.pathname.endsWith(".mp4") ? "video/mp4" : "image/webp",
        },
      });
    }) as typeof fetch;

    const [link] = dl.findUrls(`https://www.xiaohongshu.com/explore/${NOTE_ID}`);
    const [post] = await dl.fetchContent(link);

    const apiReq = requests.find((r) => r.url.includes("get_note_info_v7"))!;
    expect(new URL(apiReq.url).searchParams.get("note_id")).toBe(NOTE_ID);
    expect(apiReq.headers.get("authorization")).toBe("Bearer test-key");

    expect(post.username).toBe("jennierubyjane");
    expect(post.postID).toBe(NOTE_ID);
    expect(post.originalText).toBe("제니 ✨\n\ncaption #tag");
    expect(post.files.map((f) => f.ext)).toEqual(["webp", "webp", "mp4"]);
  });

  it("sends share_text for short links", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const req = input as Request;
      requests.push(req);
      if (req.url.includes("api.tikhub.io")) {
        return Response.json({ code: 200, data: appVideoResponse });
      }
      return new Response("bytes", { headers: { "content-type": "video/mp4" } });
    }) as typeof fetch;

    const [link] = dl.findUrls("http://xhslink.com/a/EZ4M9TwMA6c3");
    const [post] = await dl.fetchContent(link);

    const params = new URL(requests[0].url).searchParams;
    expect(params.get("share_text")).toBe("http://xhslink.com/a/EZ4M9TwMA6c3");
    expect(params.has("note_id")).toBe(false);
    expect(post.postID).toBe(NOTE_ID);
    expect(post.files).toHaveLength(1);
  });

  it("errors clearly when TIKHUB_API_KEY is missing", async () => {
    delete process.env.TIKHUB_API_KEY;
    const [link] = dl.findUrls(`https://www.xiaohongshu.com/explore/${NOTE_ID}`);
    const err = await dl.fetchContent(link).catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors[0].message).toContain("TIKHUB_API_KEY");
  });
});
