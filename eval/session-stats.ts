// Aggregates guard decision telemetry from pi's own session logs. Scans all
// session files under the pi agent dir for `custom` entries written by the
// guard extension (customType "guard") and reports decision rates, fast-path
// usage, latency, token cost, retries, and errors across real sessions.
//
// Usage:
//   node eval/session-stats.ts              # human-readable summary
//   node eval/session-stats.ts --json       # machine-readable aggregate
//   node eval/session-stats.ts --cases      # dump denied/rejected reviews as eval-case candidates
//
// Outcome hint in --cases output: `laterExecuted` is true when the same
// command string appears in a later tool call in the same session file,
// meaning a denied/rejected command eventually ran anyway (false-positive
// candidate worth turning into an EvalCase).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GuardTelemetryRecord } from "../src/telemetry.ts";

interface SessionEntry {
  type?: string;
  customType?: string;
  timestamp?: string;
  data?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

function* sessionFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

function parseEntries(file: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip truncated/corrupt trailing lines; telemetry analysis is best-effort.
    }
  }
  return entries;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function commandOf(record: GuardTelemetryRecord): string | undefined {
  if (record.kind !== "review" || !record.projection) return undefined;
  const command = record.projection.inputSummary.command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

function laterExecuted(entries: SessionEntry[], fromIndex: number, command: string): boolean {
  // A later assistant tool call containing the exact command string means the
  // denied/rejected command eventually ran (approved on retry, guard disabled,
  // or another agent step) — a false-positive candidate.
  const needle = JSON.stringify(command).slice(1, -1);
  for (let i = fromIndex + 1; i < entries.length; i++) {
    const message = entries[i]?.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    if (JSON.stringify(message.content ?? "").includes(needle)) return true;
  }
  return false;
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dumpCases = args.includes("--cases");

const sessionsDir = path.join(getAgentDir(), "sessions");
const files = [...sessionFiles(sessionsDir)];

const records: Array<{ file: string; index: number; record: GuardTelemetryRecord }> = [];
const fileEntries = new Map<string, SessionEntry[]>();
for (const file of files) {
  const entries = parseEntries(file);
  fileEntries.set(file, entries);
  entries.forEach((entry, index) => {
    if (entry.type === "custom" && entry.customType === "guard" && entry.data && typeof entry.data === "object") {
      records.push({ file, index, record: entry.data as GuardTelemetryRecord });
    }
  });
}

const reviews = records.filter((r) => r.record.kind === "review");
const blocks = records.filter((r) => r.record.kind === "block");
const approvals = records.filter((r) => r.record.kind === "approval");
const errors = records.filter((r) => r.record.kind === "error");

const decisions = { allow: 0, deny: 0, ask: 0 };
const models = new Map<string, number>();
let fastPath = 0;
let retried = 0;
let inputTokens = 0;
let outputTokens = 0;
let cacheReadTokens = 0;
let cacheWriteTokens = 0;
const latencies: number[] = [];
for (const { record } of reviews) {
  if (record.kind !== "review") continue;
  decisions[record.decision] = (decisions[record.decision] ?? 0) + 1;
  if (record.fastPath) fastPath++;
  if ((record.attempts ?? 1) > 1) retried++;
  if (record.model) models.set(record.model, (models.get(record.model) ?? 0) + 1);
  inputTokens += record.usage?.input ?? 0;
  outputTokens += record.usage?.output ?? 0;
  cacheReadTokens += record.usage?.cacheRead ?? 0;
  cacheWriteTokens += record.usage?.cacheWrite ?? 0;
  if (typeof record.latencyMs === "number") latencies.push(record.latencyMs);
}
const totalPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
const sortedLatencies = [...latencies].sort((a, b) => a - b);

const asksRejected = reviews.filter((r) => r.record.kind === "review" && r.record.userApproved === false);
const approvedPaths = approvals.filter((r) => r.record.kind === "approval" && r.record.approved).length;

const summary = {
  sessionsScanned: files.length,
  sessionsWithTelemetry: new Set(records.map((r) => r.file)).size,
  records: records.length,
  reviews: {
    total: reviews.length,
    decisions,
    fastPathRate: reviews.length ? fastPath / reviews.length : 0,
    retryRate: reviews.length ? retried / reviews.length : 0,
    asksRejectedByUser: asksRejected.length,
    latencyMs: {
      p50: percentile(sortedLatencies, 50),
      p95: percentile(sortedLatencies, 95),
      max: sortedLatencies.at(-1) ?? 0,
    },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      cacheHitRate: totalPromptTokens > 0 ? cacheReadTokens / totalPromptTokens : 0,
    },
    models: Object.fromEntries([...models.entries()].sort((a, b) => b[1] - a[1])),
  },
  policyBlocks: blocks.length,
  pathApprovals: { total: approvals.length, granted: approvedPaths, denied: approvals.length - approvedPaths },
  errors: errors.length,
};

if (dumpCases) {
  const candidates = [...reviews.filter((r) => r.record.kind === "review" && (r.record.decision === "deny" || r.record.userApproved === false))].map((r) => {
    const record = r.record as Extract<GuardTelemetryRecord, { kind: "review" }>;
    const command = commandOf(record);
    return {
      tool: record.tool,
      command,
      decision: record.decision,
      userApproved: record.userApproved,
      reason: record.reason,
      model: record.model,
      session: path.basename(r.file),
      laterExecuted: command ? laterExecuted(fileEntries.get(r.file) ?? [], r.index, command) : false,
    };
  });
  candidates.sort((a, b) => Number(b.laterExecuted) - Number(a.laterExecuted));
  console.log(JSON.stringify({ summary, candidates }, null, 2));
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
console.log(`Sessions scanned: ${summary.sessionsScanned} (${summary.sessionsWithTelemetry} with guard telemetry)`);
console.log(`Records: ${summary.records}`);
console.log("");
console.log(`Reviews: ${summary.reviews.total}  (allow ${decisions.allow}, deny ${decisions.deny}, ask ${decisions.ask})`);
console.log(`  Fast-path rate: ${pct(summary.reviews.fastPathRate)}  Retry rate: ${pct(summary.reviews.retryRate)}`);
console.log(`  Latency ms: p50 ${summary.reviews.latencyMs.p50}  p95 ${summary.reviews.latencyMs.p95}  max ${summary.reviews.latencyMs.max}`);
console.log(
  `  Tokens: ${totalPromptTokens} prompt (${summary.reviews.tokens.cacheRead} cached reads, ${pct(summary.reviews.tokens.cacheHitRate)} hit rate) / ${summary.reviews.tokens.output} out`,
);
if (summary.reviews.asksRejectedByUser > 0) console.log(`  Asks rejected by user: ${summary.reviews.asksRejectedByUser} (classifier hesitation was justified)`);
for (const [model, count] of Object.entries(summary.reviews.models)) console.log(`  Model: ${model} (${count} reviews)`);
console.log(`Policy blocks: ${summary.policyBlocks}`);
console.log(`Path approvals: ${summary.pathApprovals.total} (${summary.pathApprovals.granted} granted, ${summary.pathApprovals.denied} denied)`);
console.log(`Classifier errors: ${summary.errors}`);
if (summary.records === 0 || summary.reviews.total === 0) {
  console.log("");
  console.log("No guard telemetry found yet. Telemetry is written once classifier.telemetry (default \"minimal\") records decisions in session logs.");
}
