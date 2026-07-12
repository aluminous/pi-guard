// API-key resolution for the eval runner: environment first, then pi's own
// auth store. The store format is derived from pi's source, not observed data:
// pi-coding-agent's getAuthPath() returns `<agent dir>/auth.json`, and pi-ai's
// auth/types.d.ts defines its shape as Record<providerId, Credential> with
// Credential = { type: "api_key", key?, env? } | { type: "oauth", access, refresh, expires }.
import { readFileSync } from "node:fs";
import path from "node:path";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Same construction as pi's (non-exported) getAuthPath in coding-agent config.ts. */
function getAuthPath(): string {
  return path.join(getAgentDir(), "auth.json");
}

export type EvalKeyLookup =
  | { ok: true; apiKey: string; source: string }
  | { ok: false; reason: string };

export function resolveEvalApiKey(provider: string, env: Record<string, string | undefined> = process.env): EvalKeyLookup {
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") cleanEnv[key] = value;
  }
  const envKey = getEnvApiKey(provider, cleanEnv);
  if (envKey) return { ok: true, apiKey: envKey, source: "environment" };

  const authPath = getAuthPath();
  let text: string;
  try {
    text = readFileSync(authPath, "utf8");
  } catch {
    return { ok: false, reason: `No API key for ${provider}: no provider env var is set and pi's auth store (${authPath}) does not exist.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: `No API key for ${provider} in the environment, and pi's auth store (${authPath}) is not valid JSON.` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `No API key for ${provider} in the environment, and pi's auth store (${authPath}) has an unexpected shape.` };
  }

  const credential = (parsed as Record<string, unknown>)[provider];
  if (!credential || typeof credential !== "object") {
    return { ok: false, reason: `No API key for ${provider}: not in the environment and not logged in via pi (${authPath}).` };
  }
  const cred = credential as Record<string, unknown>;
  if (cred.type === "oauth") {
    return { ok: false, reason: `${provider} is configured with OAuth in pi's auth store; the eval needs a plain API key. Set the provider env var instead.` };
  }
  if (cred.type === "api_key" && typeof cred.key === "string" && cred.key) {
    return { ok: true, apiKey: cred.key, source: `pi auth store (${authPath})` };
  }
  return { ok: false, reason: `${provider} exists in pi's auth store but has no usable API key. Set the provider env var instead.` };
}
