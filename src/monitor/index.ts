import type { Client } from "discord.js";
import type { ServerConfig } from "../config/server_config";
import { openMetadataDb } from "./data/queries";
import { createMonitorRepository } from "./data/repository";
import { PostQueue } from "./service/queue";
import { PanelHandler } from "./handlers/panel";
import { ReviewHandler } from "./handlers/review";
import { PostHandler } from "./handlers/post";
import { ConfigHandler } from "./handlers/config";
import { InteractionDispatcher } from "./interactions";
import { registerSlashCommands } from "./commands";

export { registerSlashCommands };

export function createMonitor(
  dbPath: string,
  serverConfig: ServerConfig | null,
  client: Client,
) {
  const db = openMetadataDb(dbPath);
  const repo = createMonitorRepository(db);
  const postQueue = new PostQueue();
  const panelHandler = new PanelHandler(repo, serverConfig, client);
  const reviewHandler = new ReviewHandler(postQueue, repo);
  const postHandler = new PostHandler(repo);
  const configHandler = new ConfigHandler(repo, panelHandler);

  const dispatcher = new InteractionDispatcher(panelHandler, reviewHandler, postHandler, configHandler);

  return {
    handleInteraction: dispatcher.handleInteraction.bind(dispatcher),
    repo,
  };
}
