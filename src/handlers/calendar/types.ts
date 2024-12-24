// src/types.ts
export interface Event {
  id: string;
  date: Date;
  time: string;
  description: string;
  link?: string;
}

export interface Calendar {
  channelId: string;
  messageId: string;
  events: Event[];
}
