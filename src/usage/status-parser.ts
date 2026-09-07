import type { UsageSnapshot } from "../budget/types.ts";
import { requireParsedUsage } from "./usage-snapshot.ts";

const FIVE_HOUR = /(?:5\s*h|five[\s-]*hour)(?:\s+limit)?\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*%\s*(?:left|remaining)/i;
const WEEKLY = /weekly(?:\s+limit)?\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*%\s*(?:left|remaining)/i;
const CREDITS = /credits?\s*[:=-]?\s*(\d+(?:\.\d+)?)/i;

function numberFrom(match: RegExpMatchArray | null): number | undefined {
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Parses human-readable status output without turning missing fields into zero. */
export function parseCodexStatus(text: string, now: () => Date = () => new Date()): UsageSnapshot {
  const fiveHour = numberFrom(text.match(FIVE_HOUR));
  const weekly = numberFrom(text.match(WEEKLY));
  const creditsRemaining = numberFrom(text.match(CREDITS));
  return requireParsedUsage({
    source: "codex-cli",
    capturedAt: now().toISOString(),
    ...(fiveHour !== undefined ? { fiveHour: { remainingPercent: fiveHour } } : {}),
    ...(weekly !== undefined ? { weekly: { remainingPercent: weekly } } : {}),
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
  });
}
