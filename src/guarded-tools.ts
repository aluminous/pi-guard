import type { AccessKind } from "./policy.ts";
import { textPrefix } from "./util.ts";

export interface GuardedToolSpec {
  /** Path access checks the interceptor runs for this tool, in order. */
  access: AccessKind[];
  /** Extracts the filesystem path this call touches, when the tool takes one. */
  path?(input: Record<string, unknown>): string | undefined;
  /** Low-context input summary sent to the classifier. */
  project(input: Record<string, unknown>): Record<string, unknown>;
}

function pathParam(input: Record<string, unknown>): string | undefined {
  return typeof input.path === "string" ? input.path : undefined;
}

export const GUARDED_TOOLS: Record<string, GuardedToolSpec> = {
  bash: {
    access: [],
    project: (input) => ({ command: typeof input.command === "string" ? input.command : "", timeout: input.timeout }),
  },
  read: {
    access: ["read"],
    path: pathParam,
    project: (input) => ({ path: input.path }),
  },
  write: {
    access: ["write"],
    path: pathParam,
    project: (input) => {
      const content = typeof input.content === "string" ? input.content : "";
      // Generous prefix: content-level attacks (authorization planting, agent
      // instructions) hide in body text that a short prefix would cut off.
      return { path: input.path, contentLength: content.length, contentPrefix: textPrefix(content, 1000) };
    },
  },
  edit: {
    access: ["read", "write"],
    path: pathParam,
    project: (input) => {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      return {
        path: input.path,
        editCount: edits.length,
        edits: edits.slice(0, 3).map((edit) => {
          const e = edit && typeof edit === "object" ? (edit as Record<string, unknown>) : {};
          return {
            oldTextPrefix: typeof e.oldText === "string" ? textPrefix(e.oldText, 160) : undefined,
            newTextPrefix: typeof e.newText === "string" ? textPrefix(e.newText, 160) : undefined,
          };
        }),
      };
    },
  },
};

export function shouldReviewToolCall(toolName: string): boolean {
  return toolName in GUARDED_TOOLS;
}
