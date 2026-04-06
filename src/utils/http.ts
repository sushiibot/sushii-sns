import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { tracer } from "../tracing";

const BOT_USER_AGENT =
  "Private social media downloader Discord bot: https://github.com/sushiibot/sushii-sns";

export function fetchWithHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Seed from existing headers (handles both Request objects and plain init headers)
  const existing = input instanceof Request ? input.headers : init?.headers;
  const headers = new Headers(existing);
  headers.set("User-Agent", BOT_USER_AGENT);

  const req = input instanceof Request
    ? new Request(input, { ...init, headers })
    : new Request(input, { ...init, headers });

  // Bun's native fetch() is not undici, so UndiciInstrumentation doesn't capture
  // it. Route through tracedFetch so calls appear as child spans under sns.fetch.
  return tracedFetch(req);
}

// tracedFetch wraps Bun's native fetch() with an OTel span. Use this
// anywhere you'd call fetch() directly in a platform downloader.
export function tracedFetch(req: Request): Promise<Response> {
  const method = (req.method ?? "GET").toUpperCase();
  const { hostname } = new URL(req.url);

  return tracer.startActiveSpan(
    `${method} ${hostname}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "url.full": req.url,
        "server.address": hostname,
      },
    },
    async (span) => {
      try {
        const res = await fetch(req);
        span.setAttribute("http.response.status_code", res.status);
        if (!res.ok) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` });
        }
        return res;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export function getFileExtFromURL(url: string): string {
  const urlObj = new URL(url);
  const match = urlObj.pathname.match(/\.([^.]+)$/);
  return match?.[1] ?? "jpg";
}
