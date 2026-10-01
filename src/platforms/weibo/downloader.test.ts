import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { WeiboDownloader } from "./downloader";
import { bidToMid, htmlToText, midToBid, parseWeiboPost } from "./parse";

const dl = new WeiboDownloader();

describe("bidToMid", () => {
  it("converts a known bid", () => {
    expect(bidToMid("z0JH2lOMb")).toBe("3501756485200075");
  });

  it("round-trips", () => {
    for (const mid of ["5092682368025584", "5016922058656962", "4404101091169383"]) {
      expect(bidToMid(midToBid(mid))).toBe(mid);
    }
  });
});

describe("WeiboDownloader.findUrls", () => {
  it("matches weibo.com/{uid}/{bid} and converts to mid", () => {
    const links = dl.findUrls("dl https://weibo.com/2991905905/z0JH2lOMb");
    expect(links).toHaveLength(1);
    expect(links[0].metadata).toEqual({ platform: "weibo", mid: "3501756485200075" });
  });

  it("matches numeric mids on weibo.com and m.weibo.cn", () => {
    const links = dl.findUrls(
      "dl https://m.weibo.cn/detail/5092682368025584 https://m.weibo.cn/status/5016922058656962 https://www.weibo.com/1722594714/5092682368025584?refer_flag=1",
    );
    expect(links.map((l) => l.metadata.mid)).toEqual([
      "5092682368025584",
      "5016922058656962",
      "5092682368025584",
    ]);
  });

  it("does not match profile URLs", () => {
    expect(
      dl.findUrls(
        "dl https://weibo.com/u/1722594714 https://weibo.com/1722594714 https://weibo.com/1722594714/profile",
      ),
    ).toHaveLength(0);
  });
});

const MID = "5092682368025584";

// weibo.com ajax/statuses/show shape
const webResponse = {
  ok: 1,
  idstr: MID,
  mid: MID,
  mblogid: "OAbCdEfGh",
  created_at: "Tue Oct 01 12:00:00 +0800 2024",
  text: "short <br />text",
  text_raw: "short\ntext",
  longTextContent: "the full long text",
  user: { screen_name: "Jennie" },
  pic_ids: ["p1", "p2"],
  pic_infos: {
    p2: { type: "livephoto", largest: { url: "https://wx1.sinaimg.cn/large/p2.jpg" }, video: "https://video.weibo.com/p2.mov" },
    p1: { type: "pic", largest: { url: "https://wx1.sinaimg.cn/large/p1.jpg" }, original: { url: "https://x/orig" } },
  },
};

describe("parseWeiboPost", () => {
  it("parses pic_infos in pic_ids order with live photos and long text", () => {
    const post = parseWeiboPost({ data: webResponse }, MID);
    expect(post.username).toBe("Jennie");
    expect(post.postId).toBe("OAbCdEfGh");
    expect(post.text).toBe("the full long text");
    expect(post.timestamp?.toISOString()).toBe("2024-10-01T04:00:00.000Z");
    expect(post.media).toEqual([
      { url: "https://wx1.sinaimg.cn/large/p1.jpg", kind: "image" },
      { url: "https://wx1.sinaimg.cn/large/p2.jpg", kind: "image" },
      { url: "https://video.weibo.com/p2.mov", kind: "video" },
    ]);
  });

  it("parses mix_media_info", () => {
    const post = parseWeiboPost({
      mid: MID,
      text_raw: "mixed",
      user: { screen_name: "a" },
      mix_media_info: {
        items: [
          { type: "pic", data: { largest: { url: "https://img/1.jpg" } } },
          {
            type: "video",
            data: {
              media_info: {
                mp4_sd_url: "https://v/sd.mp4",
                playback_list: [
                  { play_info: { url: "https://v/480.mp4", width: 480, height: 854 } },
                  { play_info: { url: "https://v/1080.mp4", width: 1080, height: 1920 } },
                ],
              },
            },
          },
        ],
      },
    });
    expect(post.media).toEqual([
      { url: "https://img/1.jpg", kind: "image" },
      { url: "https://v/1080.mp4", kind: "video" },
    ]);
  });

  it("parses mobile shape (pics + page_info.urls) and html text", () => {
    const post = parseWeiboPost({
      status: {
        id: MID,
        text: 'hi<br />there &amp; <a href="/n/x">@x</a>',
        user: { screen_name: "m" },
        pics: [{ url: "https://img/thumb.jpg", large: { url: "https://img/large.jpg" } }],
        page_info: { type: "video", urls: { mp4_hd_mp4: "https://v/hd.mp4" } },
      },
    });
    expect(post.text).toBe("hi\nthere & @x");
    expect(post.media).toEqual([
      { url: "https://img/large.jpg", kind: "image" },
      { url: "https://v/hd.mp4", kind: "video" },
    ]);
  });

  it("uses retweeted media and quotes the original text", () => {
    const post = parseWeiboPost({
      mid: MID,
      text_raw: "look",
      user: { screen_name: "reposter" },
      retweeted_status: {
        mid: "1",
        text_raw: "original\npost",
        user: { screen_name: "author" },
        pic_ids: ["a"],
        pic_infos: { a: { largest: { url: "https://img/a.jpg" } } },
      },
    }, MID);
    expect(post.username).toBe("reposter");
    expect(post.text).toBe("look\n\n> RT @author: original\n> post");
    expect(post.media).toEqual([{ url: "https://img/a.jpg", kind: "image" }]);
  });

  it("allows text-only posts", () => {
    const post = parseWeiboPost({ mid: MID, text_raw: "just text", user: { screen_name: "a" } });
    expect(post.media).toEqual([]);
  });

  it("htmlToText strips tags", () => {
    expect(htmlToText("a<br/>b <span>c</span>")).toBe("a\nb c");
  });
});

describe("WeiboDownloader.fetchContent", () => {
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

  it("fetches by mid and sends a weibo Referer for media", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const req = input as Request;
      requests.push(req);
      if (req.url.includes("api.tikhub.io")) {
        return Response.json({ code: 200, data: webResponse });
      }
      return new Response("bytes", {
        headers: { "content-type": req.url.endsWith(".mov") ? "video/quicktime" : "image/jpeg" },
      });
    }) as typeof fetch;

    const [link] = dl.findUrls(`https://m.weibo.cn/detail/${MID}`);
    const [post] = await dl.fetchContent(link);

    const apiParams = new URL(requests[0].url).searchParams;
    expect(requests[0].url).toContain("/weibo/web_v2/fetch_post_detail");
    expect(apiParams.get("id")).toBe(MID);

    const mediaReqs = requests.filter((r) => !r.url.includes("api.tikhub.io"));
    expect(mediaReqs.every((r) => r.headers.get("referer") === "https://weibo.com/")).toBe(true);
    expect(post.files.map((f) => f.ext)).toEqual(["jpg", "jpg", "mov"]);
  });

  it("falls back to the app endpoint", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const req = input as Request;
      requests.push(req);
      if (req.url.includes("web_v2")) {
        return Response.json({ code: 500, message: "upstream" }, { status: 500 });
      }
      if (req.url.includes("api.tikhub.io")) {
        return Response.json({ code: 200, data: { mid: MID, text_raw: "t", user: { screen_name: "a" } } });
      }
      return new Response("bytes");
    }) as typeof fetch;

    const [link] = dl.findUrls(`https://m.weibo.cn/detail/${MID}`);
    const [post] = await dl.fetchContent(link);

    expect(new URL(requests[1].url).searchParams.get("status_id")).toBe(MID);
    expect(post.originalText).toBe("t");
    expect(post.files).toEqual([]);
  });
});
