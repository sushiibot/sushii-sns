import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import pino from "pino";
import { loggerOptions, scrubUrl } from "./logger";
import { registerSecretValue } from "./secrets";

function capture(): { log: pino.Logger; output: () => string } {
  let out = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  return { log: pino(loggerOptions, stream), output: () => out };
}

describe("scrubUrl", () => {
  test("masks webhook and interaction path tokens and token-bearing query values", () => {
    expect(
      scrubUrl("https://discord.com/api/v10/webhooks/123/abcDEF_tok?wait=true"),
    ).toBe("https://discord.com/api/v10/webhooks/123/REDACTED?wait=true");
    expect(
      scrubUrl(
        "https://discord.com/api/v10/interactions/456/aW50ZXJhY3Rpb24/callback",
      ),
    ).toBe("https://discord.com/api/v10/interactions/456/REDACTED/callback");
    expect(scrubUrl("https://api.example.com/x?a=1&key=s3cret&b=2")).toBe(
      "https://api.example.com/x?a=1&key=REDACTED&b=2",
    );
  });
});

describe("logger redaction", () => {
  test("an error carrying a token in its URL is logged without the token", () => {
    const { log, output } = capture();
    const err = Object.assign(new Error("request failed"), {
      url: "https://discord.com/api/v10/webhooks/123/webhook-token-value",
    });
    log.error({ err }, "send failed");
    expect(output()).not.toContain("webhook-token-value");
    expect(output()).toContain("webhooks/123/REDACTED");
  });

  test("a registered secret value inside an error is replaced", () => {
    registerSecretValue("loaded-secret-value-123");
    const { log, output } = capture();
    log.error(
      { err: new Error("upstream said: bad key loaded-secret-value-123") },
      "call failed",
    );
    expect(output()).not.toContain("loaded-secret-value-123");
    expect(output()).toContain("[REDACTED]");
  });

  test("authorization and RapidAPI key headers are censored by path", () => {
    const { log, output } = capture();
    log.info(
      {
        req: {
          headers: {
            authorization: "Bearer header-secret",
            "x-rapidapi-key": "nested-rapid-key",
          },
        },
        headers: {
          Authorization: "Bearer other-secret",
          "x-rapidapi-key": "top-rapid-key",
        },
      },
      "req",
    );
    expect(output()).not.toContain("header-secret");
    expect(output()).not.toContain("other-secret");
    expect(output()).not.toContain("nested-rapid-key");
    expect(output()).not.toContain("top-rapid-key");
  });
});

describe("err serializer never throws", () => {
  function logged(err: unknown): string {
    const { log, output } = capture();
    expect(() => log.error({ err }, "failed")).not.toThrow();
    return output();
  }

  test("cyclic error fields", () => {
    const ctx: Record<string, unknown> = {};
    ctx["back"] = ctx;
    const err = Object.assign(new Error("cyclic"), { ctx }) as Error & {
      self?: unknown;
    };
    err.self = err;
    expect(logged(err)).toContain("[Circular]");
  });

  test("BigInt fields", () => {
    expect(logged(Object.assign(new Error("big"), { n: 10n }))).toContain(
      '"n":"10"',
    );
  });

  test("a field whose toJSON throws", () => {
    const bad = {
      toJSON() {
        throw new Error("no");
      },
    };
    expect(logged(Object.assign(new Error("tojson"), { bad }))).toContain(
      "[Unserializable]",
    );
  });

  test.each([
    [
      'fetch "https://discord.com/api/v10/webhooks/1/quoted-webhook-tok" failed',
      "quoted-webhook-tok",
    ],
    ['GET "https://x.test/a?token=quoted-query-tok" 401', "quoted-query-tok"],
    ['header "Bearer quoted-bearer-tok" bad', "quoted-bearer-tok"],
  ])("a quoted token in the message: %s", (message, token) => {
    const out = logged(new Error(message));
    expect(out).not.toContain(token);
    expect(out).toContain("REDACTED");
  });
});

describe("message and field scrubbing", () => {
  test("an Error logged directly has its message scrubbed in msg", () => {
    const { log, output } = capture();
    log.error(
      new Error(
        "post to https://discord.com/api/v10/webhooks/1/msg-webhook-tok failed",
      ),
    );
    expect(output()).not.toContain("msg-webhook-tok");
    expect(JSON.parse(output()).msg).toContain("webhooks/1/REDACTED");
  });

  test("an { err } object without a message has the derived msg scrubbed", () => {
    const { log, output } = capture();
    log.error({ err: new Error("GET https://x.test/a?key=derived-msg-key") });
    expect(output()).not.toContain("derived-msg-key");
  });

  test("string args and top-level string fields are scrubbed", () => {
    const { log, output } = capture();
    log.info(
      { url: "https://x.test/a?access_token=field-tok" },
      "calling %s",
      "https://x.test/b?token=arg-tok",
    );
    expect(output()).not.toContain("field-tok");
    expect(output()).not.toContain("arg-tok");
  });
});

test("auth scheme scrubbing leaves ordinary prose alone", () => {
  expect(scrubUrl("using basic auth for basic setup")).toBe(
    "using basic auth for basic setup",
  );
  expect(scrubUrl("Authorization: Basic b2F1dGgyOnNlY3JldHRva2Vu")).toBe(
    "Authorization: Basic REDACTED",
  );
  expect(scrubUrl("authorization: bearer abcdefgh12345")).toBe(
    "authorization: bearer REDACTED",
  );
});

// `secrets` loads at import, so the env-loaded case needs a fresh process.
test("a secret loaded from env is scrubbed from logged errors", async () => {
  const logger = JSON.stringify(`${import.meta.dir}/logger.ts`);
  const script = `const { default: log } = await import(${logger});
log.error({ err: new Error("bad key env-loaded-rapid-key-123") }, "failed");`;
  const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      RAPID_API_KEY: "env-loaded-rapid-key-123",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  expect(out).toContain("[REDACTED]");
  expect(out).not.toContain("env-loaded-rapid-key-123");
});
