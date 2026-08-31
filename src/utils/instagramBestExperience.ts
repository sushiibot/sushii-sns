import logger from "../logger";
import { ApiUsageEndpoint, recordApiUsage } from "../apiUsage";
import { parseJsonPreservingBigIntKeys } from "./http";

const log = logger.child({ module: "instagramBestExperience" });

const HOST = "instagram-best-experience.p.rapidapi.com";

function headers(apiKey: string): HeadersInit {
  return {
    "x-rapidapi-host": HOST,
    "x-rapidapi-key": apiKey,
  };
}

/**
 * Resolve an Instagram username to its numeric user ID via
 * instagram-best-experience GET /profile. Shared by every caller that needs
 * a user_id for /feed or /stories, so the big-int-safe parsing and error
 * logging only need fixing in one place.
 */
export async function resolveInstagramUserId(
  username: string,
  apiKey: string,
): Promise<string> {
  const req = new Request(
    `https://${HOST}/profile?username=${username}`,
    { method: "GET", headers: headers(apiKey) },
  );

  const res = await fetch(req);
  recordApiUsage(ApiUsageEndpoint.RAPIDAPI_IG_BEST_EXPERIENCE_PROFILE);

  if (!res.ok) {
    const body = await res.text();
    log.error(
      { status: res.status, statusText: res.statusText, body, url: req.url },
      "instagram-best-experience /profile failed",
    );
    throw new Error(`instagram-best-experience /profile failed (${res.status})`);
  }

  const json = parseJsonPreservingBigIntKeys(await res.text(), ["pk", "id"]) as {
    pk?: string | number;
  };
  if (!json?.pk) {
    throw new Error("instagram-best-experience /profile returned no pk");
  }
  return String(json.pk);
}
