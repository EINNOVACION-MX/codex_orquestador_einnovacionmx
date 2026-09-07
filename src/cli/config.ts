import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliConfig, CliProfile } from "./types.ts";

/** Minimal optional `.cxrc` parser. Unknown or malformed lines are ignored. */
export function loadCliConfig(cwd: string): CliConfig {
  try {
    const values: Record<string, string> = {};
    for (const line of readFileSync(join(cwd, ".cxrc"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([\w]+)\s*=\s*(.*?)\s*$/);
      if (match?.[1] && match[2]) values[match[1]] = match[2];
    }
    const profile = ["auto", "balanced", "conservative", "eco", "emergency"].includes(values.profile ?? "") ? values.profile as CliProfile : undefined;
    const output = values.output === "json" || values.output === "human" ? values.output : undefined;
    const dryRun = values.dryRun === "true" ? true : values.dryRun === "false" ? false : undefined;
    return { ...(profile ? { profile } : {}), ...(output ? { output } : {}), ...(dryRun !== undefined ? { dryRun } : {}) };
  } catch { return {}; }
}
