import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexAppServerUsageProvider, parseAccountRateLimits } from "../src/usage/codex-app-server-usage-provider.ts";
import { CachedUsageProvider } from "../src/usage/cached-usage-provider.ts";
import { CodexCliUsageProvider } from "../src/usage/codex-cli-usage-provider.ts";
import { ManualUsageProvider } from "../src/usage/manual-usage-provider.ts";
import { parseCodexStatus } from "../src/usage/status-parser.ts";
import { UsageParseError, type UsageProvider } from "../src/usage/types.ts";
import { AutoModelOrchestrator } from "../src/orchestration/auto-model-orchestrator.ts";
import type { CodexExecutionRequest, CodexExecutionResult } from "../src/codex/types.ts";
import type { ExecutionService } from "../src/orchestration/types.ts";

const fixedNow = () => new Date("2026-09-06T12:00:00.000Z");

describe("usage providers", () => {
  it("creates a complete validated manual snapshot", async () => {
    const snapshot = await new ManualUsageProvider({
      fiveHourRemainingPercent: 45, weeklyRemainingPercent: 85, creditsRemaining: 341,
      fiveHourResetsAt: "2026-09-06T14:00:00.000Z", weeklyResetsAt: "2026-09-12T12:00:00.000Z",
    }, fixedNow).getUsage();
    assert.deepEqual(snapshot, {
      source: "manual", capturedAt: "2026-09-06T12:00:00.000Z",
      fiveHour: { remainingPercent: 45, resetsAt: "2026-09-06T14:00:00.000Z" },
      weekly: { remainingPercent: 85, resetsAt: "2026-09-12T12:00:00.000Z" }, creditsRemaining: 341,
    });
  });

  it("preserves partial manual snapshots and validates percentages", async () => {
    const snapshot = await new ManualUsageProvider({ weeklyRemainingPercent: 85 }, fixedNow).getUsage();
    assert.equal(snapshot.fiveHour, undefined);
    assert.equal(snapshot.weekly?.remainingPercent, 85);
    await assert.rejects(() => new ManualUsageProvider({ fiveHourRemainingPercent: 101 }).getUsage(), RangeError);
    await assert.rejects(() => new ManualUsageProvider({ creditsRemaining: -1 }).getUsage(), RangeError);
  });

  it("parses five-hour and weekly status values", () => {
    const snapshot = parseCodexStatus("5h limit: 45% left\nWeekly limit: 85% left", fixedNow);
    assert.equal(snapshot.fiveHour?.remainingPercent, 45);
    assert.equal(snapshot.weekly?.remainingPercent, 85);
  });

  it("parses weekly-only status without inventing a five-hour value", () => {
    const snapshot = parseCodexStatus("  WEEKLY LIMIT : 85% Remaining ", fixedNow);
    assert.equal(snapshot.fiveHour, undefined);
    assert.equal(snapshot.weekly?.remainingPercent, 85);
  });

  it("parses credits independently and never treats absence as zero", () => {
    const snapshot = parseCodexStatus("Credits: 341", fixedNow);
    assert.equal(snapshot.creditsRemaining, 341);
    assert.equal(snapshot.fiveHour, undefined);
    assert.equal(snapshot.weekly, undefined);
  });

  it("rejects an unknown status format", () => {
    assert.throws(() => parseCodexStatus("Ready for your next task.", fixedNow), UsageParseError);
  });

  it("caches results until maxAge and supports disabled caching", async () => {
    let calls = 0;
    let time = 0;
    const live: UsageProvider = { source: "manual", getUsage: async () => ({ source: "manual", capturedAt: fixedNow().toISOString(), weekly: { remainingPercent: 90 - ++calls } }) };
    const cached = new CachedUsageProvider(live, { maxAgeMs: 60_000, now: () => time });
    await cached.getUsage(); await cached.getUsage();
    assert.equal(calls, 1);
    time = 60_000;
    await cached.getUsage();
    assert.equal(calls, 2);
    const uncached = new CachedUsageProvider(live, { maxAgeMs: 0, now: () => time });
    await uncached.getUsage(); await uncached.getUsage();
    assert.equal(calls, 4);
  });

  it("keeps command transport separate from the tolerant parser", async () => {
    let calls = 0;
    const provider = new CodexCliUsageProvider({ readStatus: async () => { calls++; return "Weekly limit: 85% left"; } }, { maxAgeMs: 0 });
    const snapshot = await provider.getUsage();
    assert.equal(snapshot.weekly?.remainingPercent, 85);
    assert.equal(calls, 1);
  });

  it("converts the App Server rate-limit response and partial windows", () => {
    const snapshot = parseAccountRateLimits({ rateLimits: {
      primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1_788_696_000 },
      secondary: { usedPercent: 15, windowDurationMins: 10_080 }, credits: { balance: "341" },
    } }, fixedNow);
    assert.equal(snapshot.fiveHour?.remainingPercent, 45);
    assert.equal(snapshot.weekly?.remainingPercent, 85);
    assert.equal(snapshot.creditsRemaining, 341);
    const weeklyOnly = parseAccountRateLimits({ rateLimits: { secondary: { usedPercent: 15, windowDurationMins: 10_080 } } }, fixedNow);
    assert.equal(weeklyOnly.fiveHour, undefined);
    assert.equal(weeklyOnly.weekly?.remainingPercent, 85);
  });

  it("does not start a Codex turn while reading App Server usage", async () => {
    const methods: string[] = [];
    const provider = new CodexAppServerUsageProvider({ request: async <T>(method: string, params: Record<string, unknown> | null): Promise<T> => {
      methods.push(`${method}:${params === null ? "null" : "object"}`);
      return { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } } as T;
    } }, { maxAgeMs: 0 });
    const snapshot = await provider.getUsage();
    assert.equal(snapshot.fiveHour?.remainingPercent, 80);
    assert.deepEqual(methods, ["account/rateLimits/read:null"]);
    assert.equal(methods.some((method) => method.includes("turn/start")), false);
  });
});

class OneShotExecutor implements ExecutionService {
  public calls = 0;
  public async execute(input: CodexExecutionRequest): Promise<CodexExecutionResult> {
    this.calls++;
    return { requestedModel: input.routingDecision.selectedModel, resolvedModel: input.routingDecision.selectedModel, reasoning: input.routingDecision.reasoning, threadId: "thread-1", status: "completed", fallbackUsed: false, durationMs: 1 };
  }
}

describe("usage provider orchestration", () => {
  it("uses an explicit snapshot instead of invoking the configured provider", async () => {
    let providerCalls = 0;
    const executor = new OneShotExecutor();
    const provider: UsageProvider = { source: "manual", getUsage: async () => { providerCalls++; return { source: "manual", capturedAt: fixedNow().toISOString(), fiveHour: { remainingPercent: 5 } }; } };
    await new AutoModelOrchestrator({ executor, usageProvider: provider }).execute({
      prompt: "Implementa módulo de clientes con Supabase",
      usageSnapshot: { source: "manual", capturedAt: fixedNow().toISOString(), fiveHour: { remainingPercent: 90 } },
    });
    assert.equal(providerCalls, 0);
    assert.equal(executor.calls, 1);
  });

  it("automatically reads a provider when no snapshot was supplied", async () => {
    let providerCalls = 0;
    const executor = new OneShotExecutor();
    const provider: UsageProvider = { source: "manual", getUsage: async () => { providerCalls++; return { source: "manual", capturedAt: fixedNow().toISOString(), fiveHour: { remainingPercent: 25 } }; } };
    await new AutoModelOrchestrator({ executor, usageProvider: provider }).execute({ prompt: "Refactoriza un módulo complejo" });
    assert.equal(providerCalls, 1);
  });

  it("continues with an unknown snapshot when the provider fails", async () => {
    const executor = new OneShotExecutor();
    const provider: UsageProvider = { source: "codex-cli", getUsage: async () => { throw new Error("transport unavailable"); } };
    const result = await new AutoModelOrchestrator({ executor, usageProvider: provider }).execute({ prompt: "Cambia el padding del navbar" });
    assert.equal(result.budgetDecisions[0]?.state, "unknown");
    assert.equal(result.finalStatus, "success");
  });
});
