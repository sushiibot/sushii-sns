import { otelSDK } from "./tracing";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import config from "./config/config";
import { loadServerConfig } from "./config/server_config";
import { MessageCreateHandler } from "./handlers/MessageCreate";
import { handleUsageSlash } from "./handlers/usageSlash";
import { handleExtractLinksContextMenu } from "./handlers/links";
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
      GatewayIntentBits.GuildMessages,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    await MessageCreateHandler(message, serverConfig, monitor.repo);
  });

  // Always register commands — all slash commands (monitor, post, fetch-all)
  // are defined globally regardless of whether the monitor feature is enabled.
  await registerSlashCommands(config.APPLICATION_ID, config.DISCORD_TOKEN);

  const monitor = createMonitor(config.DB_PATH, serverConfig, client);
  log.info("Monitor feature enabled (config managed via /monitor config setup)");

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      log.debug(
        {
          type: interaction.type,
          commandName: interaction.isChatInputCommand() ? interaction.commandName : undefined,
          guildId: interaction.guildId,
        },
        "InteractionCreate received",
      );

      if (interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case "usage":
            await handleUsageSlash(interaction);
            break;

          case "monitor":
          case "post":
          case "fetch-all":
            await monitor.handleInteraction(interaction);
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

      if (interaction.isMessageContextMenuCommand()) {
        switch (interaction.commandName) {
          case "Attachment Links":
            await handleExtractLinksContextMenu(interaction);
            break;

          default:
            log.warn({ commandName: interaction.commandName }, "Unrecognized context menu command");
            await interaction.reply({
              content: "Unknown command.",
              flags: MessageFlags.Ephemeral,
            });
        }
        return;
      }

      // Buttons, modals, select menus — all belong to the monitor feature.
      await monitor.handleInteraction(interaction);
    } catch (err) {
      log.error({ err }, "Unhandled error in InteractionCreate handler");
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
        }
      } catch {
        // ignore
      }
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
