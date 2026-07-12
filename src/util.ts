export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function textPrefix(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated ${value.length - max} chars]` : value;
}

export function unique(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => !!item))];
}

export function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}
