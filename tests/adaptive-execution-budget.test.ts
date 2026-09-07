import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetController } from "../src/budget/budget-controller.ts";
import type { UsageSnapshot } from "../src/budget/types.ts";
import { AutoModelOrchestrator } from "../src/orchestration/auto-model-orchestrator.ts";
import type { CodexExecutionRequest, CodexExecutionResult } from "../src/codex/types.ts";
import type { EscalationDecision } from "../src/escalation/types.ts";
import type { EscalationPolicyService, ExecutionService } from "../src/orchestration/types.ts";
import { routeTask } from "../src/router.ts";
import type { ModelId } from "../src/types.ts";

function usage(fiveHour?: number, weekly?: number): UsageSnapshot {
  return { source: "manual", capturedAt: "2026-09-06T12:00:00.000Z", ...(fiveHour !== undefined ? { fiveHour: { remainingPercent: fiveHour } } : {}), ...(weekly !== undefined ? { weekly: { remainingPercent: weekly } } : {}) };
}

function decision(snapshot: UsageSnapshot | undefined, model: ModelId = "terra", minimumModel?: "sol" | "astra") {
  return new BudgetController().evaluate({ ...(snapshot ? { usage: snapshot } : {}), routingDecision: { ...routeTask({ prompt: "Implementa clientes" }), selectedModel: model }, ...(minimumModel ? { minimumModel } : {}) });
}

describe("ExecutionBudget", () => {
  it("sets total attempts for each usage state", () => {
    assert.equal(decision(usage(90, 90)).executionBudget.maxTotalAttempts, 5);
    assert.equal(decision(usage(59, 92)).executionBudget.maxTotalAttempts, 4);
    assert.equal(decision(usage(25, 70)).executionBudget.maxTotalAttempts, 3);
    assert.equal(decision(usage(8, 70)).executionBudget.maxTotalAttempts, 2);
  });

  it("uses the constrained window, supports partial snapshots, and makes absent usage conservative", () => {
    assert.equal(decision(usage(92, 59)).state, "conservative");
    assert.equal(decision(usage(92, 15)).state, "emergency");
    assert.equal(decision(usage(undefined, 25)).state, "eco");
    assert.equal(decision(undefined).state, "unknown");
    assert.equal(decision(undefined).executionBudget.maxTotalAttempts, 4);
  });

  it("limits Sol attempts in conservative mode and Astra to an explicit requirement in emergency", () => {
    assert.equal(decision(usage(59, 92), "sol").executionBudget.maxAttemptsPerModel.sol, 1);
    assert.equal(decision(usage(8, 70), "astra", "astra").executionBudget.maxAttemptsPerModel.astra, 1);
    assert.equal(decision(usage(8, 70)).executionBudget.maxAttemptsPerModel.astra, 0);
  });

  it("provides compatible reasoning caps without lowering an explicit minimum", async () => {
    const executor = new RecordingExecutor([{ status: "completed" }]);
    await new AutoModelOrchestrator(executor).execute({
      prompt: "Refactoriza un módulo complejo", routingDecision: { ...routeTask({ prompt: "Refactoriza" }), selectedModel: "sol", reasoning: "high" },
      usageSnapshot: usage(25, 70), minimumModel: "sol",
    });
    assert.equal(executor.calls[0]?.routingDecision.reasoning, "medium");
    const minimumExecutor = new RecordingExecutor([{ status: "completed" }]);
    await new AutoModelOrchestrator(minimumExecutor).execute({
      prompt: "Refactoriza", routingDecision: { ...routeTask({ prompt: "Refactoriza" }), selectedModel: "sol", reasoning: "high" },
      usageSnapshot: usage(25, 70), minimumModel: "sol", minimumReasoning: "high",
    });
    assert.equal(minimumExecutor.calls[0]?.routingDecision.reasoning, "high");
  });
});

type Outcome = { status: CodexExecutionResult["status"]; testFailure?: boolean };
class RecordingExecutor implements ExecutionService {
  public readonly calls: CodexExecutionRequest[] = [];
  private index = 0;
  private readonly outcomes: Outcome[];
  public constructor(outcomes: Outcome[]) {
    this.outcomes = outcomes;
  }
  public async execute(input: CodexExecutionRequest): Promise<CodexExecutionResult> {
    this.calls.push(input);
    const outcome = this.outcomes[this.index++] ?? { status: "failed" };
    return { requestedModel: input.routingDecision.selectedModel, resolvedModel: input.routingDecision.selectedModel, reasoning: input.routingDecision.reasoning, threadId: "t-1", status: outcome.status, fallbackUsed: false, durationMs: 1 };
  }
}

class ForceEscalation implements EscalationPolicyService {
  public decide(input: Parameters<EscalationPolicyService["decide"]>[0]): EscalationDecision {
    if (input.taskExecution.attempts.length === 0) return { action: "stop-success", currentModel: input.currentModel, reason: "done" };
    return { action: "escalate-model", currentModel: input.currentModel, nextModel: "sol", nextReasoning: "high", failureCategory: "complexity", reason: "optional escalation" };
  }
}

describe("adaptive orchestration", () => {
  it("caps Terra high to medium in emergency and prevents a second retry", async () => {
    const executor = new RecordingExecutor([{ status: "failed" }]);
    const result = await new AutoModelOrchestrator(executor).execute({
      prompt: "Implementa clientes", routingDecision: { ...routeTask({ prompt: "Implementa" }), selectedModel: "terra", reasoning: "high" }, usageSnapshot: usage(8, 70),
    });
    assert.equal(executor.calls[0]?.routingDecision.reasoning, "medium");
    assert.equal(executor.calls.length, 1);
    assert.equal(result.finalStatus, "human-review");
  });

  it("permits required Sol and critical security in emergency", async () => {
    const sol = new RecordingExecutor([{ status: "completed" }]);
    await new AutoModelOrchestrator(sol).execute({ prompt: "Analiza pagos", minimumModel: "sol", usageSnapshot: usage(8, 70) });
    assert.equal(sol.calls[0]?.routingDecision.selectedModel, "sol");
    const security = new RecordingExecutor([{ status: "completed" }]);
    await new AutoModelOrchestrator(security).execute({
      prompt: "Auditoría crítica", routingDecision: { ...routeTask({ prompt: "Auditoría" }), domain: "cybersecurity", risk: 5, selectedModel: "sol", reasoning: "high" }, usageSnapshot: usage(8, 70),
    });
    assert.equal(security.calls[0]?.routingDecision.selectedModel, "sol");
  });

  it("blocks optional Sol escalation in emergency without entering a loop", async () => {
    const executor = new RecordingExecutor([{ status: "failed" }]);
    const result = await new AutoModelOrchestrator(executor, new ForceEscalation()).execute({ prompt: "Implementa", usageSnapshot: usage(8, 70) });
    assert.equal(result.finalStatus, "human-review");
    assert.equal(executor.calls.length, 1);
  });

  it("includes budget observability in its result", async () => {
    const result = await new AutoModelOrchestrator(new RecordingExecutor([{ status: "completed" }])).execute({ prompt: "Implementa", usageSnapshot: usage(92, 59) });
    assert.equal(result.budgetState, "conservative");
    assert.equal(result.executionBudget.maxTotalAttempts, 4);
    assert.equal(result.usageSnapshot.weekly?.remainingPercent, 59);
    assert.ok(result.budgetDecisions.length >= 1);
  });
});
