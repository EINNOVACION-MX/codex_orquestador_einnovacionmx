import type { ClassificationResult, ModelId, ReasoningLevel } from "../types.ts";

export type AttemptStatus =
  | "success"
  | "failed"
  | "timeout"
  | "test-failure"
  | "execution-error";

export type TaskExecutionFinalStatus = AttemptStatus | "pending" | "dry-run" | "not-executed";

export interface TestResult {
  status: "passed" | "failed" | "skipped";
  summary?: string;
  command?: string;
}

export interface AttemptFinalResult {
  status: AttemptStatus;
  summary?: string;
}

export interface AttemptRecord {
  id: string;
  sequence: number;
  model: {
    logical: ModelId | null;
    realId: string | null;
  };
  reasoning: ReasoningLevel | null;
  threadId: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: AttemptStatus;
  error?: string;
  testResult?: TestResult;
  finalResult: AttemptFinalResult;
}

export interface TaskExecution {
  id: string;
  prompt: string;
  routingDecision: ClassificationResult;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
  attempts: AttemptRecord[];
  finalStatus: TaskExecutionFinalStatus;
  finalResult?: AttemptFinalResult;
}
