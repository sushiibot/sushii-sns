// src/utils.ts
import type { Event } from "./types";

export function parseCommand(content: string): {
  command: string;
  args: string[];
} {
  const parts = content.trim().split(/\s+/);
  const command = parts[0].toLowerCase().replace("!", "");
  const args = parts.slice(1);
  return { command, args };
}

export function formatCalendarMessage(events: Event[]): string {
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();

  const filteredEvents = events.filter((event) => {
    const eventMonth = event.date.getMonth();
    const eventYear = event.date.getFullYear();
    return eventMonth === currentMonth && eventYear === currentYear;
  });

  if (filteredEvents.length === 0) {
    return "📅 No events scheduled for this month.";
  }

  const sortedEvents = filteredEvents.sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  let message = "📅 Events this month:\n\n";
  sortedEvents.forEach((event) => {
    message += `📌 ${event.date.toLocaleDateString()} at ${event.time}\n`;
    message += `Description: ${event.description}\n`;
    if (event.link) {
      message += `Link: ${event.link}\n`;
    }
    message += `ID: ${event.id}\n\n`;
  });

  return message;
}
