import { otelSDK } from "./tracing";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import config from "./config/config";
import { loadServerConfig } from "./config/server_config";
import { MessageCreateHandler } from "./handlers/MessageCreate";
import { handleUsageSlash } from "./handlers/usageSlash";
import { loadMonitorsConfig } from "./monitor/config";
import { isDevMode } from "./monitor/runtime";
import { createMonitor, registerSlashCommands } from "./monitor";
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
    await MessageCreateHandler(message, serverConfig);
  });

  // Always register commands — all slash commands (usage, monitor, post, fetch-all)
  // are defined globally regardless of whether the monitor feature is enabled.
  await registerSlashCommands(config.APPLICATION_ID, config.DISCORD_TOKEN);

  const monitorsConfigPath = config.MONITORS_CONFIG_PATH;
  const monitorsConfig = monitorsConfigPath
    ? loadMonitorsConfig(monitorsConfigPath)
    : null;

  const monitor = monitorsConfig && monitorsConfigPath
    ? createMonitor(config.DB_PATH, monitorsConfig, serverConfig, client)
    : null;

  if (monitorsConfig) {
    log.info(
      { connections: monitorsConfig.connections.length },
      "Monitor feature enabled",
    );
  } else {
    log.info("Monitor feature disabled (MONITORS_CONFIG_PATH not set)");
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case "usage":
          await handleUsageSlash(interaction);
          break;

        case "monitor":
        case "post":
        case "fetch-all":
          if (monitor) {
            await monitor.handleInteraction(interaction);
          } else {
            await interaction.reply({
              content: "The monitor feature is not enabled on this instance (`MONITORS_CONFIG_PATH` is not set).",
              flags: MessageFlags.Ephemeral,
            });
          }
          break;

        default:
          log.warn({ commandName: interaction.commandName }, "Unrecognized slash command");
          await interaction.reply({
            content: "Unknown command.",
            flags: MessageFlags.Ephemeral,
          });
      }
      return;
    }

    // Buttons, modals, select menus — all belong to the monitor feature.
    if (monitor) {
      await monitor.handleInteraction(interaction);
      return;
    }

    if (interaction.isRepliable()) {
      await interaction.reply({
        content: "The monitor feature is not enabled on this instance.",
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  const httpServer = await startHealthCheckServer(clientHealthy(client));
  log.info({ port: httpServer.port }, "Health check server started");

  process.on("SIGTERM", async () => {
    log.info("Received SIGTERM, shutting down...");
    await client.destroy();
    await httpServer.stop();
    await otelSDK?.shutdown();
    log.info("bye");
  });

  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => logger.error(err));
