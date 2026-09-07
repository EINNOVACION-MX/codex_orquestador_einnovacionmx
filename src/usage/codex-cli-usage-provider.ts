import type { UsageSnapshot } from "../budget/types.ts";
import { CachedUsageProvider } from "./cached-usage-provider.ts";
import { parseCodexStatus } from "./status-parser.ts";
import type { CodexStatusTransport, UsageProvider, UsageProviderCacheOptions } from "./types.ts";

/** Parses a status transport. A CLI `/status` transport can be added later without changing parsing. */
export class CodexCliUsageProvider implements UsageProvider {
  public readonly source = "codex-cli" as const;
  private readonly cached: CachedUsageProvider;

  public constructor(transport: CodexStatusTransport, options: UsageProviderCacheOptions = {}) {
    const live: UsageProvider = {
      source: this.source,
      getUsage: async (): Promise<UsageSnapshot> => parseCodexStatus(await transport.readStatus()),
    };
    this.cached = new CachedUsageProvider(live, options);
  }

  public getUsage(): Promise<UsageSnapshot> {
    return this.cached.getUsage();
  }
}
