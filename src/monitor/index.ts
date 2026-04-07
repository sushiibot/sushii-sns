import type { Client } from "discord.js";
import type { ServerConfig } from "../config/server_config";
import type { MonitorsConfig } from "./config";
import { openMetadataDb } from "./data/queries";
import { createMonitorRepository } from "./data/repository";
import { ReviewStore } from "./service/review/store";
import { PostQueue } from "./service/queue";
import { PanelHandler } from "./handlers/panel";
import { ReviewHandler } from "./handlers/review";
import { PostHandler } from "./handlers/post";
import { InteractionDispatcher } from "./interactions";
import { registerSlashCommands } from "./commands";

export { registerSlashCommands };

export function createMonitor(
  dbPath: string,
  config: MonitorsConfig,
  serverConfig: ServerConfig | null,
  client: Client,
) {
  const db = openMetadataDb(dbPath);
  const repo = createMonitorRepository(db);
  const reviewStore = new ReviewStore();
  const postQueue = new PostQueue();
  const panelHandler = new PanelHandler(repo, reviewStore, config, serverConfig, client);
  const reviewHandler = new ReviewHandler(reviewStore, postQueue, repo, config);
  const postHandler = new PostHandler(repo, config);

  const dispatcher = new InteractionDispatcher(panelHandler, reviewHandler, postHandler);

  return {
    handleInteraction: dispatcher.handleInteraction.bind(dispatcher),
    registerCommands: (applicationId: string, token: string) =>
      registerSlashCommands(applicationId, token),
  };
}
