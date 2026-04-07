import {
  ChannelType,
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
    .setDescription("SNS monitor panel + connection management")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup((group) =>
      group
        .setName("config")
        .setDescription("Server monitor configuration")
        .addSubcommand((sub) =>
          sub
            .setName("setup")
            .setDescription("Set up or update monitor channels and roles for this server")
            .addChannelOption((opt) =>
              opt
                .setName("panel_channel")
                .setDescription("Channel where the poll panel lives")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true),
            )
            .addChannelOption((opt) =>
              opt
                .setName("socials_channel")
                .setDescription("Channel where approved posts are sent")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true),
            )
            .addRoleOption((opt) =>
              opt
                .setName("trigger_role")
                .setDescription("Role required to click poll buttons (leave empty for anyone)")
                .setRequired(false),
            )
            .addChannelOption((opt) =>
              opt
                .setName("log_channel")
                .setDescription("Channel for monitor system logs (optional)")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("template")
            .setDescription("Set post format and text template (opens a form)"),
        )
        .addSubcommand((sub) =>
          sub.setName("show").setDescription("Show current monitor configuration"),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("connection")
        .setDescription("Manage monitored social media accounts")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Add a social media account to monitor (opens a form)"),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Remove a monitored social media account")
            .addStringOption((opt) =>
              opt
                .setName("type")
                .setDescription("Platform")
                .setRequired(true)
                .addChoices(
                  { name: "Instagram", value: "instagram" },
                  { name: "TikTok", value: "tiktok" },
                  { name: "Twitter", value: "twitter" },
                ),
            )
            .addStringOption((opt) =>
              opt.setName("handle").setDescription("Username/handle").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("List monitored social media accounts"),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("panel")
        .setDescription("Panel setup and refresh")
        .addSubcommand((sub) =>
          sub.setName("setup").setDescription("Post/pin the monitor panel embed in this channel"),
        )
        .addSubcommand((sub) =>
          sub.setName("refresh").setDescription("Refresh the panel embed in this channel"),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("db")
        .setDescription("Purge monitor DB data")
        .addSubcommand((sub) =>
          sub
            .setName("purge-connection")
            .setDescription("Purge cooldown + seen-post data for one connection")
            .addStringOption((opt) =>
              opt
                .setName("type")
                .setDescription("Connection type")
                .setRequired(true)
                .addChoices(
                  { name: "Instagram", value: "instagram" },
                  { name: "TikTok", value: "tiktok" },
                  { name: "Twitter", value: "twitter" },
                ),
            )
            .addStringOption((opt) =>
              opt.setName("handle").setDescription("Handle/username").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("purge-all").setDescription("Purge all cooldown + seen-post data"),
        ),
    );

  const postCommand = new SlashCommandBuilder()
    .setName("post")
    .setDescription("Post a message to the monitor channel")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName("url").setDescription("Post URL").setRequired(true),
    );

  const usageCommand = new SlashCommandBuilder()
    .setName("usage")
    .setDescription("Show API call counters (used / quota hint) for this bot process")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName("scope")
        .setDescription("What to show")
        .setRequired(true)
        .addChoices(
          { name: "Providers + endpoints", value: "all" },
          { name: "Providers only", value: "providers" },
          { name: "Endpoints only", value: "endpoints" },
        ),
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
        usageCommand.toJSON(),
        fetchAllCommand.toJSON(),
      ],
    });
    log.info("Slash commands registered");
  } catch (err) {
    log.error(err, "Failed to register slash commands — monitor buttons will still work but slash commands may be unavailable");
  }
}
