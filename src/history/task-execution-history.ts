import { randomUUID } from "node:crypto";
import type { ClassificationResult, ModelId, ReasoningLevel } from "../types.ts";
import type { CodexExecutionResult, CodexExecutionStatus } from "../codex/types.ts";
import type {
  AttemptFinalResult,
  AttemptRecord,
  AttemptStatus,
  TaskExecution,
  TaskExecutionFinalStatus,
  TestResult,
} from "./types.ts";

type Clock = () => Date;

export interface ExecutionContext {
  prompt: string;
  routingDecision: ClassificationResult;
  threadId?: string | null;
}

export interface AttemptInput {
  requestedModel: ModelId;
  resolvedModel: ModelId | null;
  realModelId?: string | null;
  reasoning: ReasoningLevel | null;
  threadId: string | null;
  status: CodexExecutionStatus;
  durationMs: number;
  error?: string;
  testResult?: TestResult;
}

function finalStatusFor(status: CodexExecutionStatus): TaskExecutionFinalStatus {
  if (status === "completed") return "success";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "error") return "execution-error";
  if (status === "dry-run") return "dry-run";
  if (status === "not-executed") return "not-executed";
  return "pending";
}

function attemptStatusFor(input: AttemptInput): AttemptStatus {
  if (input.testResult?.status === "failed") return "test-failure";
  return finalStatusFor(input.status) as AttemptStatus;
}

function finalResult(status: AttemptStatus, error?: string): AttemptFinalResult {
  return {
    status,
    ...(error ? { summary: error } : {}),
  };
}

/** Immutable builder for an execution history; future escalation reads its attempts. */
export class TaskExecutionHistory {
  private readonly now: Clock;

  public constructor(now: Clock = () => new Date()) {
    this.now = now;
  }

  public begin(context: ExecutionContext, existing?: TaskExecution): TaskExecution {
    if (existing) return { ...existing, attempts: [...existing.attempts] };
    const timestamp = this.now().toISOString();
    return {
      id: randomUUID(),
      prompt: context.prompt,
      routingDecision: context.routingDecision,
      threadId: context.threadId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: [],
      finalStatus: "pending",
    };
  }

  public complete(
    execution: TaskExecution,
    result: CodexExecutionResult,
    testResult?: TestResult,
    attemptStartedAt?: string,
  ): TaskExecution {
    const timestamp = this.now().toISOString();
    const finalStatus = finalStatusFor(result.status);
    const threadId = result.threadId ?? execution.threadId;

    if (result.status === "dry-run" || result.status === "not-executed") {
      return {
        ...execution,
        threadId,
        updatedAt: timestamp,
        finalStatus,
        ...(result.error ? { finalResult: { status: "execution-error", summary: result.error } } : {}),
      };
    }

    const input: AttemptInput = {
      requestedModel: result.requestedModel,
      resolvedModel: result.resolvedModel,
      ...(result.realModelId !== undefined ? { realModelId: result.realModelId } : {}),
      reasoning: result.reasoning,
      threadId,
      status: result.status,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
      ...(testResult ? { testResult } : {}),
    };
    const attemptStatus = attemptStatusFor(input);
    const attempt: AttemptRecord = {
      id: `${execution.id}:attempt:${execution.attempts.length + 1}`,
      sequence: execution.attempts.length + 1,
      model: { logical: input.resolvedModel, realId: input.realModelId ?? null },
      reasoning: input.reasoning,
      threadId,
      startedAt: attemptStartedAt ?? timestamp,
      finishedAt: timestamp,
      durationMs: input.durationMs,
      status: attemptStatus,
      ...(input.error ? { error: input.error } : {}),
      ...(input.testResult ? { testResult: input.testResult } : {}),
      finalResult: finalResult(attemptStatus, input.error),
    };

    return {
      ...execution,
      threadId,
      updatedAt: timestamp,
      attempts: [...execution.attempts, attempt],
      finalStatus: attemptStatus,
      finalResult: attempt.finalResult,
    };
  }
}
