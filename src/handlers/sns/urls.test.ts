import { extractTwitterURLs } from "./urls";
import { describe, expect, it } from "bun:test";

describe("sns", () => {
  describe("extractTwitterURLs", () => {
    it("should find Twitter URLs", () => {
      const urls = extractTwitterURLs(
        "Check out this tweet: https://twitter.com/username/status/123456789",
      );
      expect(urls).toEqual(["https://twitter.com/username/status/123456789"]);
    });

    it("should find Twitter URLs with media", () => {
      const urls = extractTwitterURLs(
        "Check out this tweet with media: https://twitter.com/username/status/123456789/photo/1",
      );
      expect(urls).toEqual([
        "https://twitter.com/username/status/123456789/photo/1",
      ]);
    });

    it("should find Twitter URLs with query parameters", () => {
      const urls = extractTwitterURLs(
        "Check out this tweet with query parameters: https://twitter.com/username/status/123456789?ref=example",
      );
      expect(urls).toEqual([
        "https://twitter.com/username/status/123456789?ref=example",
      ]);
    });

    it("should find Twitter URLs with hashtags", () => {
      const urls = extractTwitterURLs(
        "Check out this tweet with hashtags: https://twitter.com/username/status/123456789#example",
      );
      expect(urls).toEqual([
        "https://twitter.com/username/status/123456789#example",
      ]);
    });

    it("should find Twitter URLs with case-insensitivity", () => {
      const urls = extractTwitterURLs(
        "Check out this tweet with case-insensitive URL: https://TWITTER.com/username/status/123456789",
      );
      expect(urls).toEqual(["https://TWITTER.com/username/status/123456789"]);
    });

    it("should find multiple Twitter URLs in one string", () => {
      const urls = extractTwitterURLs(
        "Check out this tweet: https://twitter.com/username/status/123456789 and this tweet: https://twitter.com/username/status/987654321",
      );

      expect(urls).toEqual([
        "https://twitter.com/username/status/123456789",
        "https://twitter.com/username/status/987654321",
      ]);
    });
  });
});
