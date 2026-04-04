import type { Server } from "bun";
import { Client, Status } from "discord.js";
import { Hono } from "hono";

export async function startHealthCheckServer(
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

export function clientHealthy(client: Client): () => boolean {
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
