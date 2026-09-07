import type { UsageSnapshot, UsageWindow } from "../budget/types.ts";
import type { CodexTransport } from "../codex/types.ts";
import { CachedUsageProvider } from "./cached-usage-provider.ts";
import { requireParsedUsage } from "./usage-snapshot.ts";
import type { UsageProvider, UsageProviderCacheOptions } from "./types.ts";

interface RawRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface RawRateLimitSnapshot {
  primary?: RawRateLimitWindow | null;
  secondary?: RawRateLimitWindow | null;
  credits?: { balance?: string | null } | null;
}

export interface AccountRateLimitsResponse {
  rateLimits: RawRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RawRateLimitSnapshot> | null;
}

function asWindow(value: RawRateLimitWindow | null | undefined): UsageWindow | undefined {
  if (!value) return undefined;
  return {
    remainingPercent: 100 - value.usedPercent,
    ...(value.resetsAt !== null && value.resetsAt !== undefined
      ? { resetsAt: new Date(value.resetsAt * 1000).toISOString() }
      : {}),
  };
}

function credits(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Converts the documented App Server rate-limit response into the compact budget snapshot. */
export function parseAccountRateLimits(
  response: AccountRateLimitsResponse,
  now: () => Date = () => new Date(),
): UsageSnapshot {
  const snapshot = response.rateLimits;
  const primary = asWindow(snapshot.primary);
  const secondary = asWindow(snapshot.secondary);
  const creditsRemaining = credits(snapshot.credits?.balance);
  const primaryIsFiveHour = snapshot.primary?.windowDurationMins === 300;
  const secondaryIsFiveHour = snapshot.secondary?.windowDurationMins === 300;
  return requireParsedUsage({
    source: "codex-cli",
    capturedAt: now().toISOString(),
    ...(primaryIsFiveHour && primary ? { fiveHour: primary } : {}),
    ...(secondaryIsFiveHour && secondary ? { fiveHour: secondary } : {}),
    ...(!primaryIsFiveHour && primary ? { weekly: primary } : {}),
    ...(!secondaryIsFiveHour && secondary ? { weekly: secondary } : {}),
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
  });
}

/** Reads `account/rateLimits/read`; it makes no thread or turn request. */
export class CodexAppServerUsageProvider implements UsageProvider {
  public readonly source = "codex-cli" as const;
  private readonly cached: CachedUsageProvider;

  public constructor(transport: Pick<CodexTransport, "request">, options: UsageProviderCacheOptions = {}) {
    const live: UsageProvider = {
      source: this.source,
      getUsage: async (): Promise<UsageSnapshot> => parseAccountRateLimits(
        await transport.request<AccountRateLimitsResponse>("account/rateLimits/read", null),
      ),
    };
    this.cached = new CachedUsageProvider(live, options);
  }

  public getUsage(): Promise<UsageSnapshot> {
    return this.cached.getUsage();
  }
}
