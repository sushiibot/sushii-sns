import "./tracing";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import config from "./config/config";
import { loadServerConfig } from "./config/server_config";
import { MessageCreateHandler } from "./handlers/MessageCreate";
import { handleUsageSlash } from "./handlers/usageSlash";
import { loadMonitorsConfig } from "./monitor/config";
import { isDevMode } from "./monitor/runtime";
import { createMonitor } from "./monitor";
import logger from "./logger";
import { clientHealthy, startHealthCheckServer } from "./server/botHttp";

const log = logger.child({ module: "bot" });

async function main(): Promise<void> {
  const monitorDevMode = isDevMode();
  log.info(
    {
      ...config,
      DISCORD_TOKEN: "********",
      BD_API_TOKEN: "********",
      RAPID_API_KEY: "********",
      MONITOR_DEV_MODE: monitorDevMode,
    },
    "Starting bot with config",
  );

  const serverConfig = config.SERVER_CONFIG_PATH
    ? loadServerConfig(config.SERVER_CONFIG_PATH)
    : null;

  if (serverConfig) {
    log.info({ guilds: serverConfig.guilds.length }, "Server config loaded");
  }

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

  const monitorsConfigPath = config.MONITORS_CONFIG_PATH;
  const monitorsConfig = monitorsConfigPath
    ? loadMonitorsConfig(monitorsConfigPath)
    : null;

  const monitor = monitorsConfig && monitorsConfigPath
    ? createMonitor(config.DB_PATH, monitorsConfig, serverConfig, client)
    : null;

  if (monitor) {
    await monitor.registerCommands(config.APPLICATION_ID, config.DISCORD_TOKEN);

    if (monitorsConfig) {
      log.info(
        { connections: monitorsConfig.connections.length },
        "Monitor feature enabled",
      );
    }
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === "usage") {
      await handleUsageSlash(interaction);
      return;
    }

    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "fetch-all" &&
      !monitor
    ) {
      await interaction.reply({
        content:
          "The monitor feature is not enabled (set MONITORS_CONFIG_PATH). `/fetch-all` is unavailable.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (monitor) {
      await monitor.handleInteraction(interaction);
    }
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
