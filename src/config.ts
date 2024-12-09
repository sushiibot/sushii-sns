import { z } from "zod";
import * as dotenv from "dotenv";
import pino from "pino";

dotenv.config();

const schema = z.object({
  LOG_LEVEL: z.string().optional().default("info"),
  DISCORD_TOKEN: z.string(),
  APPLICATION_ID: z.string(),

  BD_API_TOKEN: z.string(),

  CHANNEL_ID_WHITELIST: z
    .string()
    .transform((s) => s.split(",").map((s) => s.trim()))
    .default(""),

  SENTRY_DSN: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Temporary logger since we need the config to setup the real one
  const logger = pino();

  logger.error(
    {
      error: parsed.error.format(),
    },
    "❌ Invalid environment variables"
  );

  process.exit(1);
}

export type ConfigType = z.infer<typeof schema>;

export default parsed.data;
