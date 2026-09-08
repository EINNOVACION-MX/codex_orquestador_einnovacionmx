import type { CodexExecutionEvent, CodexExecutionRequest, CodexExecutionResult } from "../codex/types.ts";
import type { EscalationDecision, EscalationPolicyInput } from "../escalation/types.ts";
import type { TaskExecution } from "../history/types.ts";
import type { BudgetProfileName, ClassificationResult, ModelId, ReasoningLevel } from "../types.ts";
import type { ResolvedCxAttachment } from "../types.ts";
import type { BudgetDecision, BudgetState, ExecutionBudget, UsageSnapshot } from "../budget/types.ts";
import type { UsageProvider } from "../usage/types.ts";

export interface ExecutionService {
  execute(input: CodexExecutionRequest): Promise<CodexExecutionResult>;
}

export interface EscalationPolicyService {
  decide(input: EscalationPolicyInput): EscalationDecision;
}

export interface BudgetPolicyService {
  evaluate(input: {
    usage?: UsageSnapshot;
    budgetStateCap?: Exclude<BudgetState, "unknown">;
    routingDecision: ClassificationResult;
    minimumModel?: ModelId;
    escalation?: EscalationDecision;
  }): BudgetDecision;
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
  usageSnapshot?: UsageSnapshot;
  usageProvider?: UsageProvider;
  budgetStateCap?: Exclude<BudgetState, "unknown">;
  /** Required reasoning is never reduced by the adaptive budget. */
  minimumReasoning?: ReasoningLevel;
  /** Re-read a cached provider only after an escalation to Sol or Astra. */
  refreshUsageAfterCostlyEscalation?: boolean;
  dryRun?: boolean;
  limits?: AttemptLimits;
  attachments?: ResolvedCxAttachment[];
  onEvent?: (event: CodexExecutionEvent) => void;
}

export interface AutoModelOrchestratorOptions {
  usageProvider?: UsageProvider;
}

export interface AutoModelOrchestratorDependencies extends AutoModelOrchestratorOptions {
  executor: ExecutionService;
  policy?: EscalationPolicyService;
  budget?: BudgetPolicyService;
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
  budgetDecisions: BudgetDecision[];
  budgetState: import("../budget/types.ts").BudgetState;
  executionBudget: ExecutionBudget;
  usageSnapshot: UsageSnapshot;
  finalResult?: CodexExecutionResult;
  agentMessage?: string;
  notices?: string[];
  stoppedReason: string;
}
