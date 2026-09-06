import type { BudgetProfileName, ClassificationResult, ModelId, ReasoningLevel } from "../types.ts";
import type { AttemptRecord, TaskExecution } from "../history/types.ts";

export const FAILURE_CATEGORIES = [
  "recoverable",
  "complexity",
  "critical",
  "infrastructure",
  "unknown",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const ESCALATION_ACTIONS = [
  "retry-same-model",
  "escalate-model",
  "stop-success",
  "stop-failure",
  "require-human-review",
] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

export interface EscalationPolicyInput {
  taskExecution: TaskExecution;
  routingDecision: ClassificationResult;
  currentModel: ModelId;
  minimumModel?: ModelId;
  budgetProfile?: BudgetProfileName;
  lastAttempt?: AttemptRecord;
}

export interface EscalationDecision {
  action: EscalationAction;
  currentModel: ModelId;
  nextModel?: ModelId;
  nextReasoning?: ReasoningLevel;
  reason: string;
  failureCategory?: FailureCategory;
}
