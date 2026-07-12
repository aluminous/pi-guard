import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function existingRealPath(filePath: string): string | undefined {
  try {
    return existsSync(filePath) ? realpathSync.native(filePath) : undefined;
  } catch {
    return undefined;
  }
}
