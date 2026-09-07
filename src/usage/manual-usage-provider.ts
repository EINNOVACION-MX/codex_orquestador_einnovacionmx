import type { UsageSnapshot } from "../budget/types.ts";
import { validateUsageSnapshot } from "./usage-snapshot.ts";
import type { ManualUsageProviderOptions, UsageProvider } from "./types.ts";

/** Reliable fallback when Codex cannot expose account usage automatically. */
export class ManualUsageProvider implements UsageProvider {
  public readonly source = "manual" as const;
  private readonly options: ManualUsageProviderOptions;
  private readonly now: () => Date;

  public constructor(options: ManualUsageProviderOptions, now: () => Date = () => new Date()) {
    this.options = options;
    this.now = now;
  }

  public async getUsage(): Promise<UsageSnapshot> {
    const snapshot: UsageSnapshot = {
      source: this.source,
      capturedAt: this.now().toISOString(),
      ...(this.options.fiveHourRemainingPercent !== undefined ? {
        fiveHour: {
          remainingPercent: this.options.fiveHourRemainingPercent,
          ...(this.options.fiveHourResetsAt ? { resetsAt: this.options.fiveHourResetsAt } : {}),
        },
      } : {}),
      ...(this.options.weeklyRemainingPercent !== undefined ? {
        weekly: {
          remainingPercent: this.options.weeklyRemainingPercent,
          ...(this.options.weeklyResetsAt ? { resetsAt: this.options.weeklyResetsAt } : {}),
        },
      } : {}),
      ...(this.options.creditsRemaining !== undefined ? { creditsRemaining: this.options.creditsRemaining } : {}),
    };
    return validateUsageSnapshot(snapshot);
  }
}
