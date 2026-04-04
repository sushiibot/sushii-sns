# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install
bun dev              # pino-pretty log formatting
bun start
bun run typecheck
bun test
INTEGRATION=1 bun test
bun test src/platforms/twitter/downloader.test.ts  # single file
```

## Architecture

Discord bot that downloads social media (Twitter/X, Instagram posts/reels/stories, TikTok) when users post `dl <url>` in whitelisted channels.

**Message flow**: `src/index.ts` → `MessageCreate` (whitelist filter) → parallel `snsHandler` + `extractLinksHandler`. `snsHandler` requires message starting with `dl`, then `findAllSnsLinks` + async generator `snsService` streams downloads per platform.

**Downloader pattern**: `src/platforms/<name>/downloader.ts` extends `SnsDownloader<M>` (`src/platforms/base.ts`). Required: `URL_REGEX`, `createLinkFromMatch`, `fetchContent`, `buildDiscordAttachments`, `buildDiscordMessages`. Register new downloaders in `src/handlers/sns.ts`.

**Monitor** (optional, requires `MONITORS_CONFIG_PATH`): Polls connections on a pinned panel → fetches unseen posts → creates review embeds → staff approve/edit/skip before posting to socials channel. Interaction dispatch splits across `interactionPanel.ts`, `interactionPost.ts`, `interactionReview.ts`. State in SQLite (`DB_PATH`). See `docs/monitor-feature.md`.

**Config**: Zod-validated env in `src/config/config.ts`. Optional per-guild message templates via `SERVER_CONFIG_PATH` → `src/config/server_config.ts`.

## Docs

- [docs/architecture.md](docs/architecture.md) — file map, HTTP routes, env vars
- [docs/commands.md](docs/commands.md) — `dl`, `links`, slash commands
- [docs/platforms.md](docs/platforms.md) — per-platform APIs, adding a platform
- [docs/monitor-feature.md](docs/monitor-feature.md) — monitor config, DB, review flow
