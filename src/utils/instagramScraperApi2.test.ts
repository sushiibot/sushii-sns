import { describe, expect, it } from "bun:test";
import { BestExperiencePostSchema } from "../platforms/instagram-post/types";
import { getStoryItemPk, StoryItemSchema } from "../platforms/instagram-story/types";
import { normalizeScraperApi2Media, normalizeScraperApi2Story } from "./instagramScraperApi2";
import postFixture from "./fixtures/scraper-api2-post.json";
import storiesFixture from "./fixtures/scraper-api2-stories.json";
import postsFixture from "./fixtures/scraper-api2-posts.json";

describe("normalizeScraperApi2Media", () => {
  it("maps a carousel post onto the best-experience post schema", () => {
    const post = BestExperiencePostSchema.parse(normalizeScraperApi2Media(postFixture.data));

    expect(post.code).toBe("DdzsExTGLuK");
    expect(post.user?.username).toBe("mtv");
    expect(post.carousel_media).toHaveLength(2);
    const largest = postFixture.data.carousel_media[0].image_versions.items.find(
      (i) => i.width === 1080 && i.height === 1440,
    );
    expect(post.carousel_media![0].image_versions2!.candidates![0].url).toBe(largest!.url);
  });

  it("puts the largest candidate first regardless of input order", () => {
    const normalized = normalizeScraperApi2Media({
      image_versions: {
        items: [
          { url: "small", width: 360, height: 480 },
          { url: "large", width: 1080, height: 1440 },
        ],
      },
      video_versions: [
        { url: "sd", width: 480, height: 854 },
        { url: "hd", width: 720, height: 1280 },
      ],
    });

    expect(normalized.image_versions2.candidates[0].url).toBe("large");
    expect(normalized.video_versions[0].url).toBe("hd");
  });

  it("normalizes every feed item", () => {
    const items = postsFixture.data.items.map(normalizeScraperApi2Media);

    expect(items.map((i: any) => i.code)).toEqual(["DdHyaYAifb6", "DdT_4GMka0z"]);
    expect(items[0].carousel_media[0].image_versions2.candidates[0].width).toBe(1080);
    expect(items[1].image_versions2.candidates[0].width).toBe(1080);
  });
});

describe("normalizeScraperApi2Story", () => {
  it("builds a {media_pk}_{owner_pk} id matching best-experience", () => {
    const raw = storiesFixture.data.items[0];
    const story = StoryItemSchema.parse(normalizeScraperApi2Story(raw));

    expect(story.id).toBe(`${raw.id}_${raw.user.id}`);
    expect(getStoryItemPk(story)).toBe(raw.id);
    expect(story.video_versions?.[0]?.url).toBeString();
  });

  it("keeps an already-suffixed id's media pk", () => {
    const story = normalizeScraperApi2Story({ id: "111_222", user: { id: "222" } });

    expect(story.pk).toBe("111");
    expect(story.id).toBe("111_222");
  });
});
