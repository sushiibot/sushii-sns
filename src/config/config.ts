import * as dotenv from "dotenv";
import pino from "pino";
import { z } from "zod";
import { assertRequiredSecrets } from "../secrets";

dotenv.config();

const schema = z.object({
  LOG_LEVEL: z.string().optional().default("info"),
  APPLICATION_ID: z.string(),

  CHANNEL_ID_WHITELIST: z
    .string()
    .transform((s) => s.split(",").map((s) => s.trim()))
    .default(""),

  SENTRY_DSN: z.string().optional(),

  SERVER_CONFIG_PATH: z.string().optional(),

  DB_PATH: z.string().optional().default("./data.db"),
});

const parsed = schema.safeParse(process.env);

// Names and issue codes only: some zod messages echo the received value.
const invalid = parsed.success
  ? []
  : parsed.error.issues.map((i) => `${i.path.join(".")} (${i.code})`);
try {
  assertRequiredSecrets();
} catch (err) {
  invalid.push((err as Error).message);
}

if (!parsed.success || invalid.length > 0) {
  // Temporary logger since we need the config to setup the real one
  pino().error({ fields: invalid }, "❌ Invalid environment variables");
  process.exit(1);
}

export type ConfigType = z.infer<typeof schema>;

export default parsed.data;
