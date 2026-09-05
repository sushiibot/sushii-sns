# Bot commands

Three families: the **message command** (`dl`) in whitelisted channels, the **`Attachment Links` message context menu command**, and **slash commands** (all registered globally at startup).

Environment basics: `CHANNEL_ID_WHITELIST`, `DISCORD_TOKEN`, `APPLICATION_ID`. Monitor also needs `MONITORS_CONFIG_PATH` and API keys — see [architecture.md](./architecture.md#environment-variables).

The `dl` message command requires **mentioning the bot first** (`@bot dl ...`) — a bare `dl` message is ignored. This keeps the bot compliant with Discord's message content intent requirements. Mention detection/stripping lives in [`stripBotMention`](../src/utils/discord.ts).

## 1. `dl` — download media

Send a message that **mentions the bot** followed by `dl` (then a space or URL). The bot matches supported platform URLs and downloads media into the channel.

```text
@bot dl https://x.com/user/status/1234567890
@bot dl https://www.instagram.com/p/SHORTCODE/
@bot dl https://www.tiktok.com/@user/video/1234567890
```

- Only runs in channels listed in `CHANNEL_ID_WHITELIST`.
- Reactions + optional progress messaging while fetching.
- User-facing errors may use [`snsErrors.ts`](../src/handlers/snsErrors.ts); repeated provider failures can trigger [`opsAlert`](../src/utils/opsAlert.ts).

## 2. `Attachment Links` — message context menu command

Right-click (or long-press on mobile) any message → **Apps → Attachment Links**. Replies with that message's attachment URLs (chunked to Discord's length limit), or its text content if it has no attachments but contains a link. Only works in channels listed in `CHANNEL_ID_WHITELIST`, and requires **Manage Messages** by default (overridable per-guild in Integrations → Commands).

Implemented as a context menu command rather than a reply-based text command because interaction payloads always carry full target-message content, unaffected by the privileged Message Content intent the bot doesn't have — a gateway/REST-sourced message's content would come back empty here otherwise. See [`handleExtractLinksContextMenu`](../src/handlers/links.ts).

## 3. Slash commands

Registered in [`commands.ts`](../src/handlers/monitor/commands.ts). All require **Manage Server** (`ManageGuild`) except where noted.

| Command | Purpose |
|---------|---------|
| `/usage` | API usage counters for this process (`scope`: all / providers / endpoints). Handled in [`usageSlash.ts`](../src/handlers/usageSlash.ts). |
| `/monitor panel setup` | Run **in** `panel_channel_id`: post/pin or refresh the monitor panel embed. |
| `/monitor panel refresh` | Refresh the panel embed if it already exists. |
| `/monitor db purge-connection` | Purge seen-post + cooldown data for one `type` + `handle`. |
| `/monitor db purge-all` | Purge all connection metadata and seen posts (destructive). |
| `/post url:` | Fetch a single post URL and send it to `socials_channel_id` (with duplicate checks when configured). |
| `/fetch-all` | Requires monitor enabled: mark-seen sync for every connection, refresh panel; **no** review messages. |

If `MONITORS_CONFIG_PATH` is unset, `/fetch-all` replies that the monitor is disabled; `/monitor` and `/post` still exist in the app but monitor-specific behavior needs the config + DB.

## Related docs

- [architecture.md](./architecture.md) — entrypoint, HTTP routes, file layout.
- [monitor-feature.md](./monitor-feature.md) — connections, DB, review prefixes.
- [platforms.md](./platforms.md) — per-platform URLs and APIs.
