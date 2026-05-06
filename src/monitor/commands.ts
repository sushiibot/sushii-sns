import {
  InteractionContextType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import logger from "../logger";

const log = logger.child({ module: "monitor/commands" });

export async function registerSlashCommands(
  applicationId: string,
  token: string,
): Promise<void> {
  const monitorCommand = new SlashCommandBuilder()
    .setName("monitor")
    .setDescription("Monitor setup and management")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName("setup").setDescription("Open the interactive monitor setup panel"),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("panel")
        .setDescription("Panel management")
        .addSubcommand((sub) =>
          sub
            .setName("refresh")
            .setDescription("Re-send or refresh the poll panel (use if the panel message was deleted)"),
        ),
    );

  const postCommand = new SlashCommandBuilder()
    .setName("post")
    .setDescription("Manually send a URL through the monitor review flow")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName("url").setDescription("Post URL").setRequired(true),
    );

  const fetchAllCommand = new SlashCommandBuilder()
    .setName("fetch-all")
    .setDescription(
      "Poll every monitor connection, mark items as seen, refresh panel (no review messages)",
    )
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  const rest = new REST().setToken(token);

  try {
    await rest.put(Routes.applicationCommands(applicationId), {
      body: [
        monitorCommand.toJSON(),
        postCommand.toJSON(),
        fetchAllCommand.toJSON(),
      ],
    });
    log.info("Slash commands registered");
  } catch (err) {
    log.error(err, "Failed to register slash commands");
    throw err;
  }
}
