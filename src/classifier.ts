import { complete, type Message, type Model, type Api } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedGuardConfig } from "./config.ts";
import {
  buildFastReviewText,
  buildFullReviewText,
  buildRulesText,
  ClassifierModelUnavailableError,
  ClassifierRetryableError,
  FAST_SYSTEM_PROMPT,
  FULL_SYSTEM_PROMPT,
  isModelUnavailableError,
  isRetryableClassifierError,
  parseFastResult,
  parseResult,
  projectToolCall,
  retryFailureKind,
  type ClassifierResult,
  type ClassifierTokenUsage,
} from "./classifier-protocol.ts";
import { resolveAutoClassifierModel } from "./classifier-models.ts";
import { formatError, textPrefix } from "./util.ts";

export { isClassifierModelUnavailable, projectToolCall, type ClassifierResult, type ReviewProjection } from "./classifier-protocol.ts";

export interface ClassifierState {
  enabledOverride?: boolean;
  modelOverride?: string;
  lastDecision?: ClassifierResult & { toolName: string; at: number };
  lastError?: string;
}

export type CompleteFn = typeof complete;

export interface ClassifierAuthResult {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  error?: string;
}

/**
 * Everything the review flow needs from the outside world. Production code
 * adapts ExtensionContext via createClassifierIO; tests and the eval runner
 * provide scripted implementations.
 */
export interface ClassifierIO {
  cwd: string;
  signal: AbortSignal | undefined;
  complete: CompleteFn;
  getAuth(model: Model<Api>): Promise<ClassifierAuthResult>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  recentUserMessages(): string[];
  sleep(ms: number, signal: AbortSignal | undefined): Promise<void>;
}

function currentModel(ctx: ExtensionContext): Model<Api> | undefined {
  if (!ctx.model || ctx.model.provider === "unknown" || ctx.model.id === "unknown") return undefined;
  return ctx.model;
}

export function resolveClassifierModel(ctx: ExtensionContext, config: ResolvedGuardConfig, state: ClassifierState): Model<Api> | undefined {
  const spec = state.modelOverride ?? config.classifier.model;
  if (spec === "auto") {
    // Best known-good model among those with configured auth; falls back to
    // the session's current model when none of the preferences is available.
    return resolveAutoClassifierModel(ctx.modelRegistry.getAvailable()) ?? currentModel(ctx);
  }
  if (spec === "current") return currentModel(ctx);
  const slash = spec.indexOf("/");
  if (slash <= 0) return undefined;
  return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

function recentUserMessagesFromSession(ctx: ExtensionContext): string[] {
  const entries = ctx.sessionManager.getBranch() as Array<Record<string, any>>;
  const users: string[] = [];
  for (const entry of entries.slice(-30)) {
    const message = entry.message;
    if (!message || message.role !== "user") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
    if (text.trim()) users.push(textPrefix(text.trim(), 1000));
  }
  return users.slice(-6);
}

export async function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw new Error("classifier review aborted");
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("classifier review aborted"));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createClassifierIO(ctx: ExtensionContext, completeFn: CompleteFn = complete): ClassifierIO {
  return {
    cwd: ctx.cwd,
    signal: ctx.signal,
    complete: completeFn,
    getAuth: async (model) => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      return auth.ok ? { ok: true, apiKey: auth.apiKey, headers: auth.headers } : { ok: false, error: auth.error };
    },
    notify: (message, level) => ctx.ui.notify(message, level),
    recentUserMessages: () => recentUserMessagesFromSession(ctx),
    sleep: defaultSleep,
  };
}

async function completeTextOnce(params: {
  model: Model<Api>;
  io: ClassifierIO;
  systemPrompt: string;
  text: string;
  timeoutMs: number;
}): Promise<{ text: string; usage?: ClassifierTokenUsage }> {
  const auth = await params.io.getAuth(params.model);
  if (!auth.ok || !auth.apiKey) throw new ClassifierModelUnavailableError(auth.ok ? `No API key for ${params.model.provider}` : auth.error ?? "auth failed");
  const message: Message = { role: "user", content: [{ type: "text", text: params.text }], timestamp: Date.now() };
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, params.timeoutMs);
  const onParentAbort = () => controller.abort();
  params.io.signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const response = await params.io.complete(
      params.model,
      { systemPrompt: params.systemPrompt, messages: [message] },
      { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal },
    );
    if (response.stopReason === "aborted") {
      if (didTimeout) throw new ClassifierRetryableError(`reviewer timed out after ${params.timeoutMs}ms`);
      throw new Error("classifier review aborted");
    }
    if (response.stopReason === "error") {
      // Surface the provider error so retry/unavailable classification sees
      // the real cause instead of a misleading JSON parse failure.
      throw new Error((response as { errorMessage?: string }).errorMessage ?? "provider returned an error with no message");
    }
    return {
      text: response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"),
      usage: response.usage,
    };
  } catch (error) {
    if (didTimeout) throw new ClassifierRetryableError(`reviewer timed out after ${params.timeoutMs}ms`);
    if (params.io.signal?.aborted) throw new Error("classifier review aborted");
    if (isModelUnavailableError(error)) throw new ClassifierModelUnavailableError(formatError(error));
    throw error;
  } finally {
    clearTimeout(timeout);
    params.io.signal?.removeEventListener("abort", onParentAbort);
  }
}

interface RetryBudget {
  attempts: number;
  maxAttempts: number;
}

async function completeText(params: {
  model: Model<Api>;
  io: ClassifierIO;
  systemPrompt: string;
  text: string;
  timeoutMs: number;
  budget: RetryBudget;
}): Promise<{ text: string; usage?: ClassifierTokenUsage }> {
  while (params.budget.attempts < params.budget.maxAttempts) {
    params.budget.attempts++;
    const attempt = params.budget.attempts;
    try {
      if (attempt > 1) params.io.notify(`Guard classifier retry ${attempt}/${params.budget.maxAttempts}...`, "warning");
      return await completeTextOnce(params);
    } catch (error) {
      if (error instanceof ClassifierModelUnavailableError || !isRetryableClassifierError(error) || params.budget.attempts >= params.budget.maxAttempts) throw error;
      const delayMs = 250 * 2 ** (attempt - 1);
      params.io.notify(`Guard classifier attempt ${attempt}/${params.budget.maxAttempts} failed (${retryFailureKind(error)}): ${formatError(error)}. Retrying in ${delayMs}ms.`, "warning");
      await params.io.sleep(delayMs, params.io.signal);
    }
  }
  throw new Error("classifier retry loop exhausted");
}

/**
 * Runs the two-stage review flow against an injectable IO boundary. This is
 * the entry point for orchestration tests and the offline eval runner.
 */
export async function runReview(params: {
  io: ClassifierIO;
  model: Model<Api>;
  config: ResolvedGuardConfig;
  toolName: string;
  input: unknown;
}): Promise<ClassifierResult> {
  const projection = projectToolCall(params.toolName, params.input, params.io.cwd, params.config);
  const budget: RetryBudget = { attempts: 0, maxAttempts: 5 };
  const fastResponse = await completeText({
    model: params.model,
    io: params.io,
    systemPrompt: FAST_SYSTEM_PROMPT,
    text: buildFastReviewText(projection, params.config),
    timeoutMs: params.config.classifier.timeoutMs,
    budget,
  });
  const usage: ClassifierTokenUsage = {
    input: fastResponse.usage?.input ?? 0,
    output: fastResponse.usage?.output ?? 0,
  };
  const fast = parseFastResult(fastResponse.text);
  if (fast.triviallySafe) {
    return { decision: "allow", risk: "low", authorization: "medium", reason: `Fast-path trivially safe: ${fast.reason}`, tokenUsage: usage };
  }

  const fullResponse = await completeText({
    model: params.model,
    io: params.io,
    systemPrompt: FULL_SYSTEM_PROMPT,
    text: buildFullReviewText(params.io.recentUserMessages(), projection, params.config),
    timeoutMs: params.config.classifier.timeoutMs,
    budget,
  });
  usage.input += fullResponse.usage?.input ?? 0;
  usage.output += fullResponse.usage?.output ?? 0;
  const result = parseResult(fullResponse.text);
  return { ...result, tokenUsage: usage };
}

export async function reviewToolCall(params: {
  ctx: ExtensionContext;
  config: ResolvedGuardConfig;
  state: ClassifierState;
  toolName: string;
  input: unknown;
  completeFn?: CompleteFn;
}): Promise<ClassifierResult> {
  const model = resolveClassifierModel(params.ctx, params.config, params.state);
  if (!model) throw new ClassifierModelUnavailableError(`Classifier model not found: ${params.state.modelOverride ?? params.config.classifier.model}`);
  const io = createClassifierIO(params.ctx, params.completeFn);
  return runReview({ io, model, config: params.config, toolName: params.toolName, input: params.input });
}

export function buildClassifierPromptForCritique(config: ResolvedGuardConfig): string {
  return [
    "## Fast classifier system prompt",
    FAST_SYSTEM_PROMPT,
    "",
    "## Full classifier system prompt",
    FULL_SYSTEM_PROMPT,
    "",
    "## Resolved classifier rules",
    buildRulesText(config),
  ].join("\n");
}

export function classifierEnabled(config: ResolvedGuardConfig | undefined, state: ClassifierState): boolean {
  if (!config) return false;
  return state.enabledOverride ?? config.classifier.enabled;
}
