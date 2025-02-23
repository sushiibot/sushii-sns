import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { platformToString, type Platform } from "./base";

dayjs.extend(utc);
dayjs.extend(timezone);

export const KST_TIMEZONE = "Asia/Seoul";
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export function fetchWithHeaders(
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> {
  const headers = new Headers(args[1]?.headers);
  headers.set(
    "User-Agent",
    "Private social media downloader Discord bot: https://github.com/sushiibot/sushii-sns",
  );

  // Append to existing headers
  if (args[1]) {
    args[1].headers = {
      ...args[1].headers,
      ...headers,
    };
  } else {
    // No options provided
    args[1] = {
      headers,
    };
  }

  return fetch(...args);
}

export function getFileExtFromURL(url: string): string {
  const urlObj = new URL(url);
  const ext = urlObj.pathname.split(".").pop() ?? "jpg";

  return ext;
}

export function formatDiscordTitle(
  platform: Platform,
  username: string,
  date?: Date,
): string {
  const djs = dayjs(date).tz(KST_TIMEZONE);

  let title = "`";
  if (date) {
    title += djs.format("YYMMDD");
    title += " ";
  }

  const platformName = platformToString(platform);
  title += `${username} ${platformName} Update`;
  title += "`";

  return title;
}
