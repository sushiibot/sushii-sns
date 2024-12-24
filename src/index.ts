// Require the necessary discord.js classes
import { Client, Events, GatewayIntentBits, Status } from "discord.js";
import config from "./config/config";
import { MessageCreateHandler } from "./handlers/MessageCreate";
import logger from "./logger";
import { Hono } from "hono";
import type { Server } from "bun";

const log = logger.child({ module: "bot" });

async function startHealthCheckServer(
  healthyFn: () => boolean,
): Promise<Server> {
  const app = new Hono();

  app.get("/", (c) => c.text("Hono!"));
  app.get("/v1/health", (c) => {
    if (healthyFn()) {
      return c.text("OK");
    }

    return c.text("NOT OK", 500);
  });

  return Bun.serve({
    port: 8080,
    fetch: app.fetch,
  });
}

function clientHealthy(client: Client): () => boolean {
  return () => {
    switch (client.ws.status) {
      case Status.Idle:
      case Status.Ready:
      case Status.Resuming:
      case Status.Connecting:
      case Status.Identifying:
      case Status.Reconnecting:
      case Status.WaitingForGuilds:
      case Status.Nearly:
        return true;

      case Status.Disconnected:
        return false;

      default:
        return false;
    }
  };
}

async function main(): Promise<void> {
  log.info(
    {
      ...{
        ...config,
        DISCORD_TOKEN: "********",
      },
    },
    "Starting bot with config",
  );

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessages,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    await MessageCreateHandler(message);
  });

  const httpServer = await startHealthCheckServer(clientHealthy(client));
  log.info({ port: httpServer.port }, "Health check server started");

  process.on("SIGTERM", async () => {
    log.info("Received SIGTERM, shutting down...");
    await client.destroy();
    await httpServer.stop();
    log.info("bye");
  });

  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => logger.error(err));
