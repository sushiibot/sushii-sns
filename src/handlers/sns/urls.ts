const RE_TWITTER = new RegExp(
  "https?://(?:(?:www|m|mobile)\\.)?" +
    "(?:twitter\\.com|x\\.com)" +
    "/(\\w+)/status/(\\d+)(/(?:photo|video)/\\d)?/?(?:\\?\\S+)?(?:#\\S+)?",
  // 'i' flag for case-insensitivity
  // 'g' flag for global search - makes String.match() exclude capture groups
  "ig",
);

export function extractTwitterURLs(text: string): string[] {
  return text.match(RE_TWITTER) ?? [];
}

type TwitterMatch = {
  username: string;
  statusId: string;
};

export function extractTwitter(text: string): TwitterMatch[] {
  const matches = text.matchAll(RE_TWITTER);
  const results: TwitterMatch[] = [];

  for (const match of matches) {
    results.push({
      username: match[1],
      statusId: match[2],
    });
  }

  return results;
}
