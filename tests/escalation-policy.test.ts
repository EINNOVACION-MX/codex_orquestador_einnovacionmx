import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideEscalation } from "../src/escalation/escalation-policy.ts";
import type { AttemptRecord, AttemptStatus, TaskExecution, TaskExecutionFinalStatus } from "../src/history/types.ts";
import type { ClassificationResult, ModelId } from "../src/types.ts";
import { routeTask } from "../src/router.ts";

function attempt(sequence: number, status: AttemptStatus, summary?: string): AttemptRecord {
  return {
    id: `execution:attempt:${sequence}`,
    sequence,
    model: { logical: "terra", realId: "gpt-5.6-terra" },
    reasoning: "medium",
    threadId: "thread-1",
    startedAt: "2026-09-06T12:00:00.000Z",
    finishedAt: "2026-09-06T12:00:01.000Z",
    durationMs: 1000,
    status,
    ...(summary ? { error: summary } : {}),
    finalResult: { status, ...(summary ? { summary } : {}) },
  };
}

function execution(
  attempts: AttemptRecord[],
  finalStatus: TaskExecutionFinalStatus = attempts.at(-1)?.status ?? "pending",
): TaskExecution {
  const routingDecision = routeTask({ prompt: "Implementa módulo de clientes con Supabase" });
  return {
    id: "execution",
    prompt: "Implementa módulo de clientes con Supabase",
    routingDecision,
    threadId: "thread-1",
    createdAt: "2026-09-06T12:00:00.000Z",
    updatedAt: "2026-09-06T12:00:01.000Z",
    attempts,
    finalStatus,
  };
}

function decide(
  currentModel: ModelId,
  attempts: AttemptRecord[],
  options: Partial<{
    minimumModel: ModelId;
    routingDecision: ClassificationResult;
    budgetProfile: "economy" | "balanced" | "quality";
    prompt: string;
  }> = {},
) {
  const taskExecution = execution(attempts);
  const routingDecision = options.routingDecision ?? taskExecution.routingDecision;
  return decideEscalation({
    taskExecution: { ...taskExecution, ...(options.prompt ? { prompt: options.prompt } : {}) },
    routingDecision,
    currentModel,
    ...(options.minimumModel ? { minimumModel: options.minimumModel } : {}),
    ...(options.budgetProfile ? { budgetProfile: options.budgetProfile } : {}),
  });
}

describe("EscalationPolicy", () => {
  it("retries Luna after one recoverable failure", () => {
    const decision = decide("luna", [attempt(1, "test-failure")]);
    assert.deepEqual(decision, {
      action: "retry-same-model", currentModel: "luna", nextModel: "luna", nextReasoning: "medium",
      reason: "The first recoverable failure can be retried with the same model.", failureCategory: "recoverable",
    });
  });

  it("escalates Luna to Terra after repeated failures", () => {
    const decision = decide("luna", [attempt(1, "test-failure"), attempt(2, "test-failure")]);
    assert.equal(decision.action, "escalate-model");
    assert.equal(decision.nextModel, "terra");
    assert.equal(decision.nextReasoning, "medium");
    assert.equal(decision.failureCategory, "complexity");
  });

  it("retries Terra once after a recoverable failure", () => {
    const decision = decide("terra", [attempt(1, "test-failure")]);
    assert.equal(decision.action, "retry-same-model");
    assert.equal(decision.nextModel, "terra");
  });

  it("escalates Terra to Sol after repeated failures", () => {
    const decision = decide("terra", [attempt(1, "test-failure"), attempt(2, "test-failure")]);
    assert.equal(decision.action, "escalate-model");
    assert.equal(decision.nextModel, "sol");
    assert.equal(decision.nextReasoning, "high");
  });

  it("escalates persistent Sol complexity to Astra when the budget permits it", () => {
    const decision = decide("sol", [attempt(1, "failed", "unable to solve this complex architecture"), attempt(2, "failed", "unable to solve this complex architecture")], {
      budgetProfile: "quality",
    });
    assert.equal(decision.action, "escalate-model");
    assert.equal(decision.nextModel, "astra");
  });

  it("requires human review after persistent Astra failure", () => {
    const decision = decide("astra", [attempt(1, "failed", "unable to solve"), attempt(2, "failed", "unable to solve")], {
      budgetProfile: "quality",
    });
    assert.equal(decision.action, "require-human-review");
    assert.equal(decision.failureCategory, "complexity");
  });

  it("does not escalate an infrastructure failure from Terra to Sol", () => {
    const decision = decide("terra", [attempt(1, "execution-error", "Codex App Server unavailable")]);
    assert.equal(decision.action, "require-human-review");
    assert.equal(decision.nextModel, undefined);
    assert.equal(decision.failureCategory, "infrastructure");
  });

  it("stops successfully after a successful task", () => {
    const successful = attempt(1, "success");
    const taskExecution = execution([successful], "success");
    const decision = decideEscalation({ taskExecution, routingDecision: taskExecution.routingDecision, currentModel: "terra" });
    assert.equal(decision.action, "stop-success");
  });

  it("never recommends Luna or Terra when minimumModel is Sol", () => {
    const decision = decide("terra", [attempt(1, "test-failure")], { minimumModel: "sol" });
    assert.equal(decision.action, "escalate-model");
    assert.equal(decision.nextModel, "sol");
  });

  it("raises a critical security failure to the Sol minimum", () => {
    const routingDecision = { ...routeTask({ prompt: "Auditoría de seguridad" }), domain: "cybersecurity" as const, risk: 5 };
    const decision = decide("terra", [attempt(1, "test-failure")], { routingDecision, prompt: "Auditoría de seguridad" });
    assert.equal(decision.failureCategory, "critical");
    assert.equal(decision.nextModel, "sol");
  });

  it("does not escalate a trivial lint error", () => {
    const decision = decide("terra", [attempt(1, "failed", "lint formatting error")]);
    assert.equal(decision.action, "retry-same-model");
    assert.equal(decision.nextModel, "terra");
  });
});
