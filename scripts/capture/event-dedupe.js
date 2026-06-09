export function createEventFingerprint(event) {
  if (event?.sourceEventId) return `id:${event.sourceEventId}`;
  const parts = [
    event?.eventType ?? "",
    event?.occurredAt ?? "",
    event?.actor?.name ?? "",
    event?.speaker?.alias ?? event?.speaker?.name ?? "",
    event?.scene?.name ?? "",
  ];
  return parts.join("|");
}

export function hasDuplicateEvent(events, event) {
  const fp = createEventFingerprint(event);
  return events.some((e) => createEventFingerprint(e) === fp);
}

export function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const fp = createEventFingerprint(event);
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });
}
