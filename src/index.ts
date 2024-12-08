// Require the necessary discord.js classes
import { Client, Events, GatewayIntentBits } from "discord.js";
import config from "./config";
import { MessageCreateHandler } from "./handlers/MessageCreate";
import logger from "./logger";

async function main(): Promise<void> {
  logger.info(
    {
      ...{
        ...config,
        DISCORD_TOKEN: "********",
      },
    },
    "Starting bot with config"
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

  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => logger.error(err));
