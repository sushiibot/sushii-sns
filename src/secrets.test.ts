import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRequiredSecrets, loadSecrets } from "./secrets";

describe("loadSecrets", () => {
  test("a missing required secret names the variable and never echoes a value", () => {
    const env = {
      DISCORD_TOKEN: "",
      RAPID_API_KEY: "rapid-should-not-appear",
    };
    let message = "";
    try {
      assertRequiredSecrets(loadSecrets(env));
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("DISCORD_TOKEN");
    expect(message).toContain("BD_API_TOKEN");
    expect(message).not.toContain("RAPID_API_KEY");
    expect(message).not.toContain("rapid-should-not-appear");
  });

  test("all secrets present passes the startup check", () => {
    const loaded = loadSecrets({
      DISCORD_TOKEN: "d",
      BD_API_TOKEN: "b",
      RAPID_API_KEY: "r",
    });
    expect(() => assertRequiredSecrets(loaded)).not.toThrow();
  });

  test("NAME_FILE is read when set, trailing newline trimmed", () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-"));
    try {
      const file = join(dir, "discord");
      writeFileSync(file, "from-file-token\n");
      expect(loadSecrets({ DISCORD_TOKEN_FILE: file }).DISCORD_TOKEN).toBe(
        "from-file-token",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable NAME_FILE names the variable and the error code only", () => {
    expect(() => loadSecrets({ BD_API_TOKEN_FILE: "/nonexistent/bd" })).toThrow(
      "BD_API_TOKEN_FILE could not be read (ENOENT)",
    );
  });

  test("an empty secret counts as unset, and the result is frozen", () => {
    const loaded = loadSecrets({ DISCORD_TOKEN: "k", RAPID_API_KEY: "" });
    expect(loaded.RAPID_API_KEY).toBeUndefined();
    expect(Object.isFrozen(loaded)).toBe(true);
  });
});
