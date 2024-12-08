// joins items into a string with a separator, multiple chunks with max
// length of 2000 characters
export function itemsToMessageContents(items: string[]): string[] {
  const msgs = [];

  let currentMsg = "";
  for (const item of items) {
    if (currentMsg.length + item.length > 2000) {
      msgs.push(currentMsg);
      currentMsg = "";
    }

    currentMsg += item + "\n";
  }

  // Push last message if not empty
  if (currentMsg.length > 0) {
    msgs.push(currentMsg);
  }

  return msgs;
}
