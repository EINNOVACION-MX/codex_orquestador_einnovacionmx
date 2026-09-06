import type { CodexExecutionRequest, CodexExecutionResult } from "../codex/types.ts";
import type { EscalationDecision, EscalationPolicyInput } from "../escalation/types.ts";
import type { TaskExecution } from "../history/types.ts";
import type { BudgetProfileName, ClassificationResult, ModelId, ReasoningLevel } from "../types.ts";

export interface ExecutionService {
  execute(input: CodexExecutionRequest): Promise<CodexExecutionResult>;
}

export interface EscalationPolicyService {
  decide(input: EscalationPolicyInput): EscalationDecision;
}

export interface AttemptLimits {
  perModel: Readonly<Record<ModelId, number>>;
  maxTotalAttempts: number;
}

export const DEFAULT_ATTEMPT_LIMITS: AttemptLimits = {
  perModel: { luna: 2, terra: 2, sol: 2, astra: 1 },
  maxTotalAttempts: 5,
};

export interface OrchestrationRequest {
  prompt: string;
  routingDecision?: ClassificationResult;
  threadId?: string;
  taskExecution?: TaskExecution;
  minimumModel?: ModelId;
  budgetProfile?: BudgetProfileName;
  dryRun?: boolean;
  limits?: AttemptLimits;
}

export type OrchestrationStatus =
  | "success"
  | "failed"
  | "dry-run"
  | "human-review"
  | "limit-reached"
  | "unavailable";

export interface OrchestrationResult {
  taskExecution: TaskExecution;
  finalStatus: OrchestrationStatus;
  finalModel: ModelId | null;
  finalReasoning: ReasoningLevel | null;
  totalAttempts: number;
  escalations: EscalationDecision[];
  finalResult?: CodexExecutionResult;
  stoppedReason: string;
}
