// src/commands.ts
import { randomUUID } from "crypto";
import { Message } from "discord.js";
import type { Calendar, Event } from "./types";
import { formatCalendarMessage } from "./utils";

export async function handleNewCalendar(
  message: Message,
  calendars: Map<string, Calendar>,
) {
  const channel = message.mentions.channels.first();
  if (!channel) {
    await message.reply("Please mention a channel to create the calendar in");
    return;
  }

  if (!channel.isSendable()) {
    await message.reply("Channel must be a text channel");
    return;
  }

  const calendarMessage = await channel.send(
    "📅 No events scheduled for this month.",
  );

  calendars.set(channel.id, {
    channelId: channel.id,
    messageId: calendarMessage.id,
    events: [],
  });

  await message.reply(`Calendar created in ${channel}`);
}

export async function handleNewEvent(
  message: Message,
  args: string[],
  calendars: Map<string, Calendar>,
) {
  const channel = message.mentions.channels.first();
  if (!channel) {
    await message.reply("Please mention a channel where the calendar exists");
    return;
  }

  const calendar = calendars.get(channel.id);
  if (!calendar) {
    await message.reply("No calendar found in this channel");
    return;
  }

  // Expected format: !newevent #channel YYYY-MM-DD HH:MM description [link]
  const [, dateStr, time, ...descriptionParts] = args;
  const description = descriptionParts.join(" ").split("http")[0].trim();
  const link = descriptionParts.join(" ").includes("http")
    ? "http" + descriptionParts.join(" ").split("http")[1].trim()
    : undefined;

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    await message.reply("Invalid date format. Please use YYYY-MM-DD");
    return;
  }

  const newEvent: Event = {
    id: randomUUID(),
    date,
    time,
    description,
    link,
  };

  calendar.events.push(newEvent);

  const calendarMessage = await channel.messages.fetch(calendar.messageId);
  await calendarMessage.edit(formatCalendarMessage(calendar.events));

  await message.reply("Event added successfully");
}

export async function handleDeleteEvent(
  message: Message,
  args: string[],
  calendars: Map<string, Calendar>,
) {
  const channel = message.mentions.channels.first();
  if (!channel) {
    await message.reply("Please mention a channel where the calendar exists");
    return;
  }

  const calendar = calendars.get(channel.id);
  if (!calendar) {
    await message.reply("No calendar found in this channel");
    return;
  }

  const [, eventId] = args;
  const eventIndex = calendar.events.findIndex((event) => event.id === eventId);

  if (eventIndex === -1) {
    await message.reply("Event not found");
    return;
  }

  calendar.events.splice(eventIndex, 1);

  const calendarMessage = await channel.messages.fetch(calendar.messageId);
  await calendarMessage.edit(formatCalendarMessage(calendar.events));

  await message.reply("Event deleted successfully");
}

export async function handleEditEvent(
  message: Message,
  args: string[],
  calendars: Map<string, Calendar>,
) {
  const channel = message.mentions.channels.first();
  if (!channel) {
    await message.reply("Please mention a channel where the calendar exists");
    return;
  }

  const calendar = calendars.get(channel.id);
  if (!calendar) {
    await message.reply("No calendar found in this channel");
    return;
  }

  // Expected format: !editevent #channel eventId YYYY-MM-DD HH:MM description [link]
  const [, eventId, dateStr, time, ...descriptionParts] = args;
  const description = descriptionParts.join(" ").split("http")[0].trim();
  const link = descriptionParts.join(" ").includes("http")
    ? "http" + descriptionParts.join(" ").split("http")[1].trim()
    : undefined;

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    await message.reply("Invalid date format. Please use YYYY-MM-DD");
    return;
  }

  const eventIndex = calendar.events.findIndex((event) => event.id === eventId);
  if (eventIndex === -1) {
    await message.reply("Event not found");
    return;
  }

  calendar.events[eventIndex] = {
    ...calendar.events[eventIndex],
    date,
    time,
    description,
    link,
  };

  const calendarMessage = await channel.messages.fetch(calendar.messageId);
  await calendarMessage.edit(formatCalendarMessage(calendar.events));

  await message.reply("Event updated successfully");
}
