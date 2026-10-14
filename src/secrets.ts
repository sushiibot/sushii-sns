import { readFileSync } from "node:fs";
import { z } from "zod";

// Optional at load so modules (and tests) import cleanly; startup enforces presence via assertRequiredSecrets.
const optional = z.string().min(1).optional();

const schema = z.object({
  DISCORD_TOKEN: optional,
  BD_API_TOKEN: optional,
  RAPID_API_KEY: optional,
});

export type Secrets = Readonly<z.infer<typeof schema>>;
export type SecretName = keyof Secrets;

const extraValues = new Set<string>();

/** One secret by name, with the NAME_FILE fallback; empty counts as unset. */
export function readSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const file = env[`${name}_FILE`];
  if (!file) return env[name] || undefined;
  try {
    return readFileSync(file, "utf8").trimEnd() || undefined;
  } catch (err) {
    throw new Error(
      `${name}_FILE could not be read (${(err as NodeJS.ErrnoException).code})`,
    );
  }
}

/** Adds a value derived at runtime (e.g. an encoded auth header) to log scrubbing. */
export function registerSecretValue(value: string): void {
  extraValues.add(value);
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const raw = Object.fromEntries(
    Object.keys(schema.shape).map((k) => [k, readSecret(k, env)]),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Names and issue codes only: some zod messages echo the received value.
    const names = parsed.error.issues.map(
      (i) => `${i.path.join(".")} (${i.code})`,
    );
    throw new Error(`Missing or invalid secrets: ${names.join(", ")}`);
  }
  return Object.freeze(parsed.data);
}

export const secrets = loadSecrets();

/** Throws naming every missing secret; called once at startup. */
export function assertRequiredSecrets(loaded: Secrets = secrets): void {
  const missing = (Object.keys(schema.shape) as SecretName[]).filter(
    (k) => !loaded[k],
  );
  if (missing.length > 0) {
    throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  }
}

export function requireSecret(name: SecretName): string {
  const value = secrets[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function knownSecretValues(): string[] {
  return [...Object.values(secrets), ...extraValues].filter(
    (v): v is string => typeof v === "string" && v.length >= 8,
  );
}
