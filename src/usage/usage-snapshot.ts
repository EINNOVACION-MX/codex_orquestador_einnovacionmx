import type { UsageSnapshot, UsageWindow } from "../budget/types.ts";
import { UsageParseError } from "./types.ts";

function validatePercent(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${field} must be a percentage between 0 and 100.`);
  }
}

function validateWindow(window: UsageWindow | undefined, field: string): void {
  if (window) validatePercent(window.remainingPercent, `${field}.remainingPercent`);
}

/** Validates a snapshot at the provider boundary, before it reaches budget policy. */
export function validateUsageSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  if (Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new RangeError("capturedAt must be a valid date string.");
  }
  validateWindow(snapshot.fiveHour, "fiveHour");
  validateWindow(snapshot.weekly, "weekly");
  if (snapshot.creditsRemaining !== undefined && (!Number.isFinite(snapshot.creditsRemaining) || snapshot.creditsRemaining < 0)) {
    throw new RangeError("creditsRemaining must be a non-negative finite number.");
  }
  return snapshot;
}

export function unknownUsageSnapshot(now: () => Date = () => new Date()): UsageSnapshot {
  return { source: "unknown", capturedAt: now().toISOString() };
}

export function requireParsedUsage(snapshot: UsageSnapshot): UsageSnapshot {
  if (!snapshot.fiveHour && !snapshot.weekly && snapshot.creditsRemaining === undefined) {
    throw new UsageParseError("Codex usage output did not contain a recognized usage value.");
  }
  return validateUsageSnapshot(snapshot);
}
