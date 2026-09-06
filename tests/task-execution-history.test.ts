import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskExecutionHistory } from "../src/history/task-execution-history.ts";
import { routeTask } from "../src/router.ts";

const decision = routeTask({ prompt: "Implementa módulo de clientes con Supabase" });
const timestamp = "2026-09-06T12:00:00.000Z";

function history(): TaskExecutionHistory {
  return new TaskExecutionHistory(() => new Date(timestamp));
}

describe("TaskExecutionHistory", () => {
  it("creates a structured execution and records a successful attempt", () => {
    const recorder = history();
    const execution = recorder.begin({ prompt: "Implementa módulo de clientes con Supabase", routingDecision: decision });
    const completed = recorder.complete(execution, {
      requestedModel: "terra",
      resolvedModel: "terra",
      realModelId: "gpt-5.6-terra",
      reasoning: "medium",
      threadId: "thread-1",
      status: "completed",
      fallbackUsed: false,
      durationMs: 42,
    }, undefined, "2026-09-06T11:59:00.000Z");

    assert.equal(completed.threadId, "thread-1");
    assert.equal(completed.finalStatus, "success");
    assert.equal(completed.attempts.length, 1);
    assert.deepEqual(completed.attempts[0], {
      id: `${execution.id}:attempt:1`,
      sequence: 1,
      model: { logical: "terra", realId: "gpt-5.6-terra" },
      reasoning: "medium",
      threadId: "thread-1",
      startedAt: "2026-09-06T11:59:00.000Z",
      finishedAt: timestamp,
      durationMs: 42,
      status: "success",
      finalResult: { status: "success" },
    });
  });

  it("records a test failure separately from the turn status", () => {
    const recorder = history();
    const execution = recorder.begin({ prompt: "Corrige el módulo", routingDecision: decision });
    const completed = recorder.complete(execution, {
      requestedModel: "terra",
      resolvedModel: "terra",
      reasoning: "medium",
      threadId: "thread-2",
      status: "completed",
      fallbackUsed: false,
      durationMs: 12,
    }, { status: "failed", command: "npm test", summary: "2 tests failed" });

    assert.equal(completed.finalStatus, "test-failure");
    assert.deepEqual(completed.attempts[0]?.testResult, {
      status: "failed",
      command: "npm test",
      summary: "2 tests failed",
    });
  });

  it("preserves existing attempts for a later manual attempt", () => {
    const recorder = history();
    const initial = recorder.begin({ prompt: "Corrige el módulo", routingDecision: decision });
    const first = recorder.complete(initial, {
      requestedModel: "terra", resolvedModel: "terra", reasoning: "medium", threadId: "thread-3",
      status: "failed", fallbackUsed: false, durationMs: 4, error: "Build failed",
    });
    const second = recorder.complete(recorder.begin({ prompt: "Corrige el módulo", routingDecision: decision }, first), {
      requestedModel: "sol", resolvedModel: "sol", reasoning: "high", threadId: "thread-3",
      status: "completed", fallbackUsed: false, durationMs: 9,
    });

    assert.equal(second.attempts.length, 2);
    assert.equal(second.attempts[0]?.status, "failed");
    assert.equal(second.attempts[1]?.sequence, 2);
    assert.equal(second.attempts[1]?.model.logical, "sol");
    assert.equal(second.finalStatus, "success");
  });

  it("does not create an attempt for dry-run or unavailable resolution", () => {
    const recorder = history();
    const execution = recorder.begin({ prompt: "Vista previa", routingDecision: decision });
    const dryRun = recorder.complete(execution, {
      requestedModel: "terra", resolvedModel: "terra", reasoning: "medium", threadId: null,
      status: "dry-run", fallbackUsed: false, durationMs: 1,
    });
    const unavailable = recorder.complete(dryRun, {
      requestedModel: "sol", resolvedModel: null, reasoning: null, threadId: null,
      status: "not-executed", fallbackUsed: false, durationMs: 1, error: "Sol unavailable",
    });

    assert.equal(unavailable.attempts.length, 0);
    assert.equal(unavailable.finalStatus, "not-executed");
    assert.equal(unavailable.finalResult?.summary, "Sol unavailable");
  });
});
