# Supported platforms

Platform code lives under [`src/platforms/`](../src/platforms/). Each downloader extends [`SnsDownloader<M>`](../src/platforms/base.ts) and returns [`PostData`](../src/platforms/base.ts) with buffers for the central handler to upload.

## Shared contract

1. **`PLATFORM`** — e.g. `twitter`, `instagram`, `instagram-story`, `tiktok`.
2. **`URL_REGEX`** — finds URLs in message text.
3. **`createLinkFromMatch`** — builds `SnsLink` metadata.
4. **`buildApiRequest` / `fetchContent`** — call external APIs and download media.
5. **`buildDiscordAttachments` / `buildDiscordMessages`** — chunk attachments and format captions with CDN URLs.

Downloaders are registered in [`sns.ts`](../src/handlers/sns.ts) (`findAllSnsLinks` uses all of them).

## Twitter / X

- **Path:** [`src/platforms/twitter/downloader.ts`](../src/platforms/twitter/downloader.ts)
- **URLs:** `x.com` / `twitter.com` status links (`/user/status/id`, optional `/photo/n`).
- **API:** `api.fxtwitter.com` (third-party JSON).

## Instagram posts & reels

- **Path:** [`src/platforms/instagram-post/downloader.ts`](../src/platforms/instagram-post/downloader.ts)
- **URLs:** `/p/`, `/reel/`, `/reels/`, `/tv/`, and `user/reel/shortcode` style paths.
- **API:** RapidAPI `instagram-best-experience` → `instagram-scraper-api2` (`/v1/post_info`) → `instagram-looter2`, then Bright Data datasets (async snapshot: trigger → poll → fetch) as last resort.
- `instagram-scraper-api2` responses are mapped onto the best-experience shape in [`instagramScraperApi2.ts`](../src/utils/instagramScraperApi2.ts). looter2's `display_url` is a center-cropped square, so the largest `display_resources` entry is used instead.

## Instagram stories

- **Path:** [`src/platforms/instagram-story/downloader.ts`](../src/platforms/instagram-story/downloader.ts)
- **URLs:** `https://www.instagram.com/stories/{username}/{storyId}/` (one story) and `https://www.instagram.com/{username}/` (all active stories).
- **API:** RapidAPI `instagram-best-experience` (`/profile` → user ID, then `/stories`), falling back to `instagram-scraper-api2` (`/v1/stories` by username). Bright Data has no stories dataset.
- Story IDs are normalized to `{media_pk}_{owner_pk}` for both providers, so monitor seen-state doesn't change when a fallback serves the request. The monitor feed also falls back to `instagram-scraper-api2` `/v1/posts`.

## TikTok

- **Path:** [`src/platforms/tiktok/downloader.ts`](../src/platforms/tiktok/downloader.ts)
- **URLs:** `tiktok.com/@user/video/{id}`.
- **API:** RapidAPI (`tiktok-best-experience.p.rapidapi.com`).

## Adding a platform

1. Add `src/platforms/<name>/downloader.ts` + types if needed.
2. Extend `SnsMetadata` / `Platform` in [`base.ts`](../src/platforms/base.ts) if required.
3. Register the downloader in the `downloaders` array in [`sns.ts`](../src/handlers/sns.ts).
