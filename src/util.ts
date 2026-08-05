/**
 * One error in a wrapped chain, flattened to the fields that explain it.
 *
 * Node's fetch reports every transport failure as a bare "fetch failed"; the
 * ECONNRESET / ETIMEDOUT / ENOTFOUND that actually explains it sits one or two
 * levels down in `cause` (or in an AggregateError's `errors`), carrying the
 * `code`/`errno`/`syscall` fields nobody sees. Everything that diagnoses a
 * failure — the formatted message, the failure kind, the retry decision — reads
 * this chain instead of the outer message, so they all agree on the cause.
 */
export interface ErrorChainNode {
  name: string;
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  status?: number;
}

const CHAIN_DEPTH_LIMIT = 6;
const ERROR_TEXT_LIMIT = 300;

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Walks `cause` (and the first entry of an AggregateError's `errors`, which is
 * how a multi-address connect failure reports itself) outward-in. Depth- and
 * cycle-bounded: a self-referential cause must not hang a notification.
 */
export function errorChain(error: unknown): ErrorChainNode[] {
  const chain: ErrorChainNode[] = [];
  const visited = new Set<unknown>();
  let node: unknown = error;
  while (node !== undefined && node !== null && chain.length < CHAIN_DEPTH_LIMIT) {
    if (typeof node !== "object") {
      chain.push({ name: "", message: String(node) });
      break;
    }
    if (visited.has(node)) break;
    visited.add(node);
    const record = node as Record<string, unknown>;
    chain.push({
      name: node instanceof Error ? node.name : (readString(record, "name") ?? ""),
      message: readString(record, "message") ?? "",
      code: readString(record, "code"),
      errno: readNumber(record, ["errno"]),
      syscall: readString(record, "syscall"),
      status: readNumber(record, ["status", "statusCode"]),
    });
    node = record.cause ?? (Array.isArray(record.errors) ? record.errors[0] : undefined);
  }
  return chain;
}

/**
 * The one error-to-string helper. Renders the whole cause chain — "fetch
 * failed ← read ECONNRESET [errno -54]" — because the outer message alone is
 * exactly the useless half. Repeated text is dropped (a cause that restates its
 * wrapper, a `code` already spelled out in the message) and the result is
 * capped, since this feeds notifications, block reasons, and telemetry.
 */
export function formatError(error: unknown): string {
  const segments: string[] = [];
  let seen = "";
  const isNew = (text: string) => text.length > 0 && !seen.includes(text.toLowerCase());
  const remember = (text: string) => {
    seen += ` ${text.toLowerCase()}`;
  };
  for (const node of errorChain(error)) {
    const message = isNew(node.message) ? node.message : "";
    if (message) remember(message);
    const fields: string[] = [];
    const addField = (label: string, value: string | number | undefined) => {
      if (value === undefined || !isNew(String(value))) return;
      fields.push(`${label} ${value}`);
      remember(String(value));
    };
    addField("code", node.code);
    addField("status", node.status);
    addField("errno", node.errno);
    addField("syscall", node.syscall);
    if (!message && fields.length === 0) continue;
    segments.push(message && fields.length > 0 ? `${message} [${fields.join(", ")}]` : message || `[${fields.join(", ")}]`);
  }
  const text = segments.join(" ← ");
  return text ? textPrefix(text, ERROR_TEXT_LIMIT) : String(error);
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
