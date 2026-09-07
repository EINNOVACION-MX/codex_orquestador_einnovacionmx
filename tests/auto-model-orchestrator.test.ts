import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AutoModelOrchestrator } from "../src/orchestration/auto-model-orchestrator.ts";
import type { CodexExecutionRequest, CodexExecutionResult } from "../src/codex/types.ts";
import { TaskExecutionHistory } from "../src/history/task-execution-history.ts";
import type { TestResult } from "../src/history/types.ts";
import type { ExecutionService } from "../src/orchestration/types.ts";
import { routeTask } from "../src/router.ts";

type Outcome = {
  status: CodexExecutionResult["status"];
  error?: string;
  testFailure?: boolean;
};

class ScriptedExecutor implements ExecutionService {
  public readonly calls: CodexExecutionRequest[] = [];
  private index = 0;
  private readonly history = new TaskExecutionHistory(() => new Date("2026-09-06T12:00:00.000Z"));
  private readonly outcomes: Outcome[];

  public constructor(outcomes: Outcome[]) {
    this.outcomes = outcomes;
  }

  public async execute(input: CodexExecutionRequest): Promise<CodexExecutionResult> {
    this.calls.push(input);
    const outcome = this.outcomes[this.index++] ?? { status: "failed", error: "Missing scripted outcome" };
    const result: CodexExecutionResult = {
      requestedModel: input.routingDecision.selectedModel,
      resolvedModel: outcome.status === "not-executed" ? null : input.routingDecision.selectedModel,
      realModelId: outcome.status === "not-executed" ? null : `real-${input.routingDecision.selectedModel}`,
      reasoning: outcome.status === "not-executed" ? null : input.routingDecision.reasoning,
      threadId: input.threadId ?? "thread-1",
      status: outcome.status,
      fallbackUsed: false,
      durationMs: 5,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    const taskExecution = this.history.complete(
      input.taskExecution ?? this.history.begin({ prompt: input.prompt, routingDecision: input.routingDecision }),
      result,
      outcome.testFailure ? ({ status: "failed", summary: "tests failed" } satisfies TestResult) : undefined,
    );
    return { ...result, taskExecution };
  }
}

function orchestrate(outcomes: Outcome[]) {
  return new AutoModelOrchestrator(new ScriptedExecutor(outcomes));
}

function callModels(executor: ScriptedExecutor): string[] {
  return executor.calls.map((call) => call.routingDecision.selectedModel);
}

describe("AutoModelOrchestrator", () => {
  it("stops on success in the first attempt", async () => {
    const executor = new ScriptedExecutor([{ status: "completed" }]);
    const result = await new AutoModelOrchestrator(executor).execute({ prompt: "Implementa módulo de clientes con Supabase" });

    assert.equal(result.finalStatus, "success");
    assert.equal(result.totalAttempts, 1);
    assert.deepEqual(callModels(executor), ["terra"]);
  });

  it("retries Luna and succeeds in the same thread", async () => {
    const executor = new ScriptedExecutor([{ status: "failed", testFailure: true }, { status: "completed" }]);
    const result = await new AutoModelOrchestrator(executor).execute({ prompt: "Cambia el padding del navbar" });

    assert.equal(result.finalStatus, "success");
    assert.deepEqual(callModels(executor), ["luna", "luna"]);
    assert.equal(executor.calls[1]?.threadId, "thread-1");
    assert.match(executor.calls[1]?.prompt ?? "", /Revisa el resultado/);
  });

  it("escalates repeated Luna failures to Terra", async () => {
    const executor = new ScriptedExecutor([
      { status: "failed", testFailure: true }, { status: "failed", testFailure: true }, { status: "completed" },
    ]);
    const result = await new AutoModelOrchestrator(executor).execute({ prompt: "Cambia el padding del navbar" });

    assert.deepEqual(callModels(executor), ["luna", "luna", "terra"]);
    assert.equal(result.taskExecution.attempts[2]?.sequence, 3);
    assert.equal(result.escalations[1]?.nextModel, "terra");
  });

  it("escalates repeated Terra failures to Sol", async () => {
    const executor = new ScriptedExecutor([
      { status: "failed", testFailure: true }, { status: "failed", testFailure: true }, { status: "completed" },
    ]);
    await new AutoModelOrchestrator(executor).execute({ prompt: "Implementa módulo de clientes con Supabase" });

    assert.deepEqual(callModels(executor), ["terra", "terra", "sol"]);
    assert.equal(executor.calls[2]?.threadId, "thread-1");
  });

  it("escalates persistent Sol failures to logical Astra when permitted", async () => {
    const executor = new ScriptedExecutor([
      { status: "failed", testFailure: true },
      { status: "failed", testFailure: true },
      { status: "completed" },
    ]);
    await new AutoModelOrchestrator(executor).execute({
      prompt: "Refactoriza un módulo complejo",
      routingDecision: { ...routeTask({ prompt: "Refactoriza un módulo complejo" }), selectedModel: "sol", reasoning: "high" },
      budgetProfile: "quality",
      usageSnapshot: { source: "manual", capturedAt: "2026-09-06T12:00:00.000Z", fiveHour: { remainingPercent: 90 } },
    });

    assert.deepEqual(callModels(executor), ["sol", "sol", "astra"]);
  });

  it("stops at the balanced Astra execution budget", async () => {
    const executor = new ScriptedExecutor([
      { status: "failed", testFailure: true },
      { status: "failed", testFailure: true },
    ]);
    const result = await new AutoModelOrchestrator(executor).execute({
      prompt: "Arquitectura crítica", routingDecision: { ...routeTask({ prompt: "Arquitectura crítica" }), selectedModel: "astra", reasoning: "xhigh" },
      budgetProfile: "quality",
      usageSnapshot: { source: "manual", capturedAt: "2026-09-06T12:00:00.000Z", fiveHour: { remainingPercent: 90 } },
      limits: { perModel: { luna: 2, terra: 2, sol: 2, astra: 2 }, maxTotalAttempts: 5 },
    });

    assert.equal(result.finalStatus, "limit-reached");
    assert.deepEqual(callModels(executor), ["astra"]);
  });

  it("does not escalate infrastructure failure", async () => {
    const executor = new ScriptedExecutor([{ status: "error", error: "Codex App Server unavailable" }]);
    const result = await new AutoModelOrchestrator(executor).execute({ prompt: "Implementa módulo de clientes con Supabase" });

    assert.equal(result.finalStatus, "human-review");
    assert.deepEqual(callModels(executor), ["terra"]);
  });

  it("stops at the global attempt limit", async () => {
    const executor = new ScriptedExecutor([{ status: "failed", testFailure: true }]);
    const result = await new AutoModelOrchestrator(executor).execute({
      prompt: "Cambia el padding del navbar",
      limits: { perModel: { luna: 2, terra: 2, sol: 2, astra: 1 }, maxTotalAttempts: 1 },
    });

    assert.equal(result.finalStatus, "limit-reached");
    assert.equal(result.totalAttempts, 1);
  });

  it("honors minimumModel before the first attempt", async () => {
    const executor = new ScriptedExecutor([{ status: "completed" }]);
    await new AutoModelOrchestrator(executor).execute({
      prompt: "Cambia el padding del navbar",
      minimumModel: "sol",
    });

    assert.deepEqual(callModels(executor), ["sol"]);
  });

  it("stops in a controlled state when an exact escalated model is unavailable", async () => {
    const executor = new ScriptedExecutor([
      { status: "failed", testFailure: true },
      { status: "failed", testFailure: true },
      { status: "not-executed", error: "Astra unavailable" },
    ]);
    const result = await new AutoModelOrchestrator(executor).execute({
      prompt: "Refactoriza un módulo complejo",
      routingDecision: { ...routeTask({ prompt: "Refactoriza un módulo complejo" }), selectedModel: "sol", reasoning: "high" },
      budgetProfile: "quality",
      usageSnapshot: { source: "manual", capturedAt: "2026-09-06T12:00:00.000Z", fiveHour: { remainingPercent: 90 } },
    });

    assert.equal(result.finalStatus, "unavailable");
    assert.equal(executor.calls[2]?.minimumModel, "astra");
  });

  it("keeps attempt sequences and one TaskExecution across retries", async () => {
    const executor = new ScriptedExecutor([{ status: "failed", testFailure: true }, { status: "completed" }]);
    const result = await new AutoModelOrchestrator(executor).execute({ prompt: "Cambia el padding del navbar" });

    assert.deepEqual(result.taskExecution.attempts.map((attempt) => attempt.sequence), [1, 2]);
    assert.equal(result.taskExecution.threadId, "thread-1");
  });

  it("does not start retry turns in dry-run", async () => {
    const executor = new ScriptedExecutor([{ status: "dry-run" }]);
    const result = await new AutoModelOrchestrator(executor).execute({
      prompt: "Implementa módulo de clientes con Supabase",
      dryRun: true,
    });

    assert.equal(result.finalStatus, "dry-run");
    assert.equal(executor.calls.length, 1);
  });

  it("applies an eco usage snapshot before the first execution", async () => {
    const executor = new ScriptedExecutor([{ status: "completed" }]);
    await new AutoModelOrchestrator(executor).execute({
      prompt: "Refactoriza un módulo complejo",
      routingDecision: { ...routeTask({ prompt: "Refactoriza un módulo complejo" }), selectedModel: "sol", reasoning: "high" },
      usageSnapshot: { source: "manual", capturedAt: "2026-09-06T12:00:00.000Z", fiveHour: { remainingPercent: 25 } },
    });

    assert.equal(executor.calls[0]?.routingDecision.selectedModel, "terra");
  });
});
