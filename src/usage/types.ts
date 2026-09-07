import type { UsageSnapshot } from "../budget/types.ts";

export interface UsageProvider {
  readonly source: UsageSnapshot["source"];
  getUsage(): Promise<UsageSnapshot>;
}

export interface ManualUsageProviderOptions {
  fiveHourRemainingPercent?: number;
  weeklyRemainingPercent?: number;
  creditsRemaining?: number;
  fiveHourResetsAt?: string;
  weeklyResetsAt?: string;
}

/** Boundary for a future interactive `/status` capture. No PTY implementation is included. */
export interface CodexStatusTransport {
  readStatus(): Promise<string>;
}

export interface UsageProviderCacheOptions {
  maxAgeMs?: number;
  now?: () => number;
}

export class UsageParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UsageParseError";
  }
}
