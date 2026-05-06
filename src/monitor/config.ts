import { z } from "zod";
import { DEFAULT_INLINE_TEMPLATE, DEFAULT_LINKS_TEMPLATE } from "../utils/template";

export const ConnectionTypeSchema = z.enum(["instagram", "tiktok", "twitter"]);

export const ConnectionSchema = z.object({
  type: ConnectionTypeSchema,
  handle: z.string().min(1),
  cooldown_seconds: z.number().int().nonnegative(),
  profile_name: z.string().nullable().optional(),
});

export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;

export class MonitorsConfig {
  readonly panel_channel_id: string;
  readonly panel_message_id: string | null;
  readonly socials_channel_id: string;
  readonly trigger_role_id: string | null;
  readonly log_channel_id: string | null;
  readonly format: "links" | "inline";
  /** Raw stored template — empty string means "use default". */
  private readonly rawTemplate: string;
  readonly connections: Connection[];

  constructor(data: {
    panel_channel_id: string;
    panel_message_id: string | null;
    socials_channel_id: string;
    trigger_role_id: string | null;
    log_channel_id: string | null;
    format: "links" | "inline";
    template: string;
    connections: Connection[];
  }) {
    this.panel_channel_id = data.panel_channel_id;
    this.panel_message_id = data.panel_message_id;
    this.socials_channel_id = data.socials_channel_id;
    this.trigger_role_id = data.trigger_role_id;
    this.log_channel_id = data.log_channel_id;
    this.format = data.format;
    this.rawTemplate = data.template;
    this.connections = data.connections;
  }

  /** Always returns a non-empty template string, falling back to the format default. */
  get template(): string {
    if (this.rawTemplate) return this.rawTemplate;
    return this.format === "links" ? DEFAULT_LINKS_TEMPLATE : DEFAULT_INLINE_TEMPLATE;
  }

  /** Returns the raw stored template value (empty string if none stored). Use for UI pre-fills. */
  get storedTemplate(): string {
    return this.rawTemplate;
  }
}

export function getConnectionId(connection: Pick<Connection, "type" | "handle">): string {
  return `${connection.type}:${connection.handle}`;
}

export function parseConnectionId(connectionId: string): { type: string; handle: string } | null {
  const colonIdx = connectionId.indexOf(":");
  if (colonIdx === -1) return null;
  const type = connectionId.slice(0, colonIdx);
  const handle = connectionId.slice(colonIdx + 1);
  if (!type || !handle) return null;
  return { type, handle };
}

export function findConnectionById(config: MonitorsConfig, connectionId: string): Connection | null {
  const parts = parseConnectionId(connectionId);
  if (!parts) return null;
  return config.connections.find((c) => c.type === parts.type && c.handle === parts.handle) ?? null;
}
