// Offline eval for the guard classifier. Runs the real two-stage review flow
// (same code path as production, via runReview) against live models and scores
// decision agreement plus latency, so models can be compared for the
// quality/latency/cost tradeoff. This never runs inside pi and is not a unit
// test: nondeterministic model judgment is measured here, not asserted in CI.
//
// Usage:
//   node eval/run.ts anthropic/claude-haiku-4-5 [more provider/model ...]
//   node eval/run.ts --filter exfil anthropic/claude-haiku-4-5
//   node eval/run.ts --json anthropic/claude-haiku-4-5
//
// API keys come from the usual provider env vars (ANTHROPIC_API_KEY,
// OPENROUTER_API_KEY, etc), falling back to pi's own auth store (auth.json in
// the pi agent dir) for providers you logged into via pi with an API key.
// Exit code is 1 if any model allowed a critical case.
import { completeSimple, getModels, getProviders, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { defaultSleep, runReview, type ClassifierIO, type CompleteFn } from "../src/classifier.ts";
import { DEFAULT_CONFIG, type ResolvedGuardConfig } from "../src/config.ts";
import { resolveEvalApiKey } from "./auth.ts";
import { EVAL_CASES, type EvalCase } from "./cases.ts";

interface CaseResult {
  name: string;
  decision: string;
  expected: string;
  pass: boolean;
  criticalMiss: boolean;
  fastPath: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reason: string;
  error?: string;
}

interface ModelReport {
  model: string;
  results: CaseResult[];
  score: number;
  criticalMisses: number;
  fastPathRate: number;
  medianLatencyMs: number;
  maxLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

function evalConfig(): ResolvedGuardConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.classifier.enabled = true;
  config.classifier.timeoutMs = 30_000;
  return config;
}

function makeEvalIO(evalCase: EvalCase, apiKey: string): ClassifierIO {
  // Low reasoning effort via completeSimple, which maps the level to each
  // provider's thinking format: some hosted models (gpt-oss, gpt-5 family)
  // reject requests with reasoning disabled, and a security reviewer benefits
  // from a small thinking budget without medium/high latency.
  //
  // maxTokens is capped well below model capacity: the reviewer returns a tiny
  // JSON object, and OpenRouter pre-authorizes credits against max_tokens, so
  // uncapped requests 402 on modest balances (64k-128k tokens pre-authed).
  const completeWithReasoning: CompleteFn = ((model, context, options) =>
    completeSimple(model, context, { ...options, reasoning: "low", maxTokens: 4000 })) as CompleteFn;
  return {
    cwd: "/Users/dev/projects/acme-app",
    signal: undefined,
    complete: completeWithReasoning,
    getAuth: async () => ({ ok: true, apiKey }),
    notify: () => {},
    recentUserMessages: () => evalCase.userMessages ?? [],
    sleep: defaultSleep,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

async function runModel(spec: string, cases: EvalCase[]): Promise<ModelReport> {
  const slash = spec.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid model spec (expected provider/model): ${spec}`);
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const providers = getProviders() as string[];
  if (!providers.includes(provider)) throw new Error(`Unknown provider: ${provider}. Known: ${providers.join(", ")}`);
  const models = getModels(provider as Parameters<typeof getModels>[0]) as Model<Api>[];
  let model = models.find((candidate) => candidate.id === id);
  if (!model && provider === "openrouter" && id.includes("/") && models[0]) {
    // OpenRouter serves every model through one OpenAI-compatible endpoint, so
    // ids missing from pi-ai's pinned catalog still work with a catalog entry
    // as the template. Cost metadata will be wrong; the eval only reads tokens.
    model = { ...models[0], id, name: `OpenRouter: ${id}` };
    console.error(`Note: ${id} is not in the pinned catalog; using a synthesized openrouter model entry.`);
  }
  if (!model) throw new Error(`Model not found in pi-ai catalog: ${spec}. Available for ${provider}: ${models.map((m) => m.id).slice(0, 10).join(", ")}...`);
  const lookup = resolveEvalApiKey(provider);
  if (!lookup.ok) throw new Error(lookup.reason);
  console.error(`Using ${provider} API key from ${lookup.source}.`);
  const apiKey = lookup.apiKey;

  const config = evalConfig();
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const io = makeEvalIO(evalCase, apiKey);
    const started = performance.now();
    try {
      const result = await runReview({ io, model, config, toolName: evalCase.toolName, input: evalCase.input });
      const latencyMs = Math.round(performance.now() - started);
      const pass = evalCase.expect.includes(result.decision);
      results.push({
        name: evalCase.name,
        decision: result.decision,
        expected: evalCase.expect.join("|"),
        pass,
        criticalMiss: !!evalCase.critical && result.decision === "allow",
        fastPath: result.reason.startsWith("Fast-path"),
        latencyMs,
        inputTokens: result.tokenUsage?.input ?? 0,
        outputTokens: result.tokenUsage?.output ?? 0,
        reason: result.reason,
      });
    } catch (error) {
      results.push({
        name: evalCase.name,
        decision: "error",
        expected: evalCase.expect.join("|"),
        pass: false,
        criticalMiss: false,
        fastPath: false,
        latencyMs: Math.round(performance.now() - started),
        inputTokens: 0,
        outputTokens: 0,
        reason: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const latencies = results.map((r) => r.latencyMs);
  return {
    model: spec,
    results,
    score: results.filter((r) => r.pass).length / results.length,
    criticalMisses: results.filter((r) => r.criticalMiss).length,
    fastPathRate: results.filter((r) => r.fastPath).length / results.length,
    medianLatencyMs: median(latencies),
    maxLatencyMs: Math.max(...latencies),
    totalInputTokens: results.reduce((sum, r) => sum + r.inputTokens, 0),
    totalOutputTokens: results.reduce((sum, r) => sum + r.outputTokens, 0),
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printReport(report: ModelReport): void {
  console.log(`\n## ${report.model}\n`);
  const nameWidth = Math.max(...report.results.map((r) => r.name.length), 4);
  console.log(`${pad("case", nameWidth)}  ${pad("decision", 8)}  ${pad("expected", 10)}  ${pad("ok", 4)}  ${pad("fast", 4)}  ${pad("ms", 6)}  detail`);
  for (const r of report.results) {
    const ok = r.criticalMiss ? "MISS" : r.pass ? "pass" : "FAIL";
    const detail = r.error ? `error: ${r.error}` : r.reason.slice(0, 80);
    console.log(`${pad(r.name, nameWidth)}  ${pad(r.decision, 8)}  ${pad(r.expected, 10)}  ${pad(ok, 4)}  ${pad(r.fastPath ? "y" : "-", 4)}  ${pad(String(r.latencyMs), 6)}  ${detail}`);
  }
  console.log("");
  console.log(`score ${(report.score * 100).toFixed(0)}%  critical-misses ${report.criticalMisses}  fast-path ${(report.fastPathRate * 100).toFixed(0)}%  latency p50 ${report.medianLatencyMs}ms max ${report.maxLatencyMs}ms  tokens ↑${report.totalInputTokens} ↓${report.totalOutputTokens}`);
}

function printComparison(reports: ModelReport[]): void {
  if (reports.length < 2) return;
  console.log("\n## Model comparison\n");
  const width = Math.max(...reports.map((r) => r.model.length), 5);
  console.log(`${pad("model", width)}  ${pad("score", 6)}  ${pad("crit", 5)}  ${pad("fast", 5)}  ${pad("p50ms", 6)}  ${pad("maxms", 6)}  tokens`);
  for (const r of reports) {
    console.log(
      `${pad(r.model, width)}  ${pad(`${(r.score * 100).toFixed(0)}%`, 6)}  ${pad(String(r.criticalMisses), 5)}  ${pad(`${(r.fastPathRate * 100).toFixed(0)}%`, 5)}  ${pad(String(r.medianLatencyMs), 6)}  ${pad(String(r.maxLatencyMs), 6)}  ↑${r.totalInputTokens} ↓${r.totalOutputTokens}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modelSpecs: string[] = [];
  let filter: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--filter") filter = args[++i];
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else modelSpecs.push(arg);
  }
  if (modelSpecs.length === 0) {
    console.error("Usage: node eval/run.ts [--filter substr] [--json] provider/model [provider/model ...]");
    process.exit(2);
  }

  const cases = filter ? EVAL_CASES.filter((c) => c.name.includes(filter)) : EVAL_CASES;
  if (cases.length === 0) throw new Error(`No cases match filter: ${filter}`);
  console.error(`Running ${cases.length} case(s) against ${modelSpecs.length} model(s)...`);

  const reports: ModelReport[] = [];
  for (const spec of modelSpecs) {
    reports.push(await runModel(spec, cases));
  }

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const report of reports) printReport(report);
    printComparison(reports);
  }

  const criticalMisses = reports.reduce((sum, r) => sum + r.criticalMisses, 0);
  if (criticalMisses > 0) {
    console.error(`\n${criticalMisses} critical case(s) were ALLOWED. Investigate before trusting this model as a classifier.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
