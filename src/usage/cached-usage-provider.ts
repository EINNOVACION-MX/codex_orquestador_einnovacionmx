import type { UsageSnapshot } from "../budget/types.ts";
import type { UsageProvider, UsageProviderCacheOptions } from "./types.ts";

/** Small in-memory cache; maxAgeMs <= 0 disables caching. */
export class CachedUsageProvider implements UsageProvider {
  public readonly source: UsageSnapshot["source"];
  private readonly provider: UsageProvider;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private cached?: { value: UsageSnapshot; at: number };

  public constructor(provider: UsageProvider, options: UsageProviderCacheOptions = {}) {
    this.provider = provider;
    this.source = provider.source;
    this.maxAgeMs = options.maxAgeMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  public async getUsage(): Promise<UsageSnapshot> {
    const now = this.now();
    if (this.maxAgeMs > 0 && this.cached && now - this.cached.at < this.maxAgeMs) return this.cached.value;
    const value = await this.provider.getUsage();
    if (this.maxAgeMs > 0) this.cached = { value, at: now };
    return value;
  }
}
