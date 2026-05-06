import { z } from "zod";

export const ConnectionTypeSchema = z.enum(["instagram", "tiktok", "twitter"]);

export const ConnectionSchema = z.object({
  type: ConnectionTypeSchema,
  handle: z.string().min(1),
  cooldown_seconds: z.number().int().nonnegative(),
  profile_name: z.string().nullable().optional(),
});

export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;

export interface MonitorsConfig {
  panel_channel_id: string;
  panel_message_id: string | null;
  socials_channel_id: string;
  trigger_role_id: string | null;
  log_channel_id: string | null;
  format: "links" | "inline";
  template: string;
  connections: Connection[];
}

export function getConnectionId(connection: Pick<Connection, "type" | "handle">): string {
  return `${connection.type}:${connection.handle}`;
}

export function findConnectionById(config: MonitorsConfig, connectionId: string): Connection | null {
  const colonIdx = connectionId.indexOf(":");
  if (colonIdx === -1) return null;
  const type = connectionId.slice(0, colonIdx);
  const handle = connectionId.slice(colonIdx + 1);
  if (!type || !handle) return null;
  return config.connections.find((c) => c.type === type && c.handle === handle) ?? null;
}
