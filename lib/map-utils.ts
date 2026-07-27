export function recordToMap<T>(record: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(record));
}

export function mapToRecord<T>(map: Map<string, T>): Record<string, T> {
  return Object.fromEntries(map.entries());
}
