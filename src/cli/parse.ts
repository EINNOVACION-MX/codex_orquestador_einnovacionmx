import { MODEL_IDS, REASONING_LEVELS, type ModelId, type ReasoningLevel } from "../types.ts";
import { CliInputError, type CliConfig, type CliOptions, type CliProfile } from "./types.ts";

const PROFILES: readonly CliProfile[] = ["auto", "balanced", "conservative", "eco", "emergency"];

function value<T extends string>(flag: string, raw: string | undefined, allowed: readonly T[]): T {
  if (!raw || !allowed.includes(raw as T)) throw new CliInputError(`${flag} must be one of: ${allowed.join(", ")}.`);
  return raw as T;
}

export function parseCliArgs(args: readonly string[], config: CliConfig = {}): CliOptions {
  const defaults: CliOptions = { command: "run", dryRun: config.dryRun ?? false, json: config.output === "json", profile: config.profile ?? "auto", noEscalation: false };
  if (args.length === 0) return { ...defaults, command: "interactive" };
  if (args.length === 1 && args[0] === "status") return { ...defaults, command: "status" };
  let prompt: string | undefined;
  const result: CliOptions = { ...defaults };
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--dry-run") result.dryRun = true;
    else if (token === "--json") result.json = true;
    else if (token === "--no-escalation") result.noEscalation = true;
    else if (token === "--profile") result.profile = value("--profile", args[++index], PROFILES);
    else if (token === "--model") result.model = value<ModelId>("--model", args[++index], MODEL_IDS);
    else if (token === "--reasoning") result.reasoning = value<ReasoningLevel>("--reasoning", args[++index], REASONING_LEVELS);
    else if (token === "--image" || token === "-i") { const path = args[++index]; if (!path) throw new CliInputError(`${token} requires an image path.`); result.attachments = [...(result.attachments ?? []), { type: "image", path }]; }
    else if (token?.startsWith("-")) throw new CliInputError(`Unknown option: ${token}`);
    else if (!prompt) prompt = token;
    else throw new CliInputError("Provide one quoted prompt.");
  }
  if (!prompt?.trim()) throw new CliInputError("Provide a prompt, or use `cx status`.");
  return { ...result, prompt };
}
