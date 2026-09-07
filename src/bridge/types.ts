import type { BudgetState, ExecutionBudget, UsageSnapshot } from "../budget/types.ts";
import type { CliAdapter } from "../cli/types.ts";
import type { ClassificationResult, ModelId, ReasoningLevel } from "../types.ts";
import type { ProjectContextEnvelope, ProjectMetadata } from "../project/types.ts";
import type { OrchestrationResult } from "../orchestration/types.ts";

export interface CxRouteResult {
  domain: ClassificationResult["domain"];
  taskType: ClassificationResult["taskType"];
  complexity: number;
  risk: number;
  usage: UsageSnapshot;
  budget: BudgetState;
  selectedModel: ModelId;
  reasoning: ReasoningLevel;
  reasons: string[];
  executionBudget: ExecutionBudget;
  hasVisualContext?: boolean;
}
export interface CxProjectResult { metadata: ProjectMetadata; reindexed: boolean; activeThreadId?: string; threadCount: number; }
export interface CxNativeExecutionResult {
  project: string;
  taskType: ClassificationResult["taskType"];
  selectedModel: ModelId | null;
  reasoning: ReasoningLevel | null;
  budgetState: BudgetState;
  attempts: number;
  escalations: string[];
  status: OrchestrationResult["finalStatus"];
  summary: string;
  threadId?: string;
}
export interface CxExecuteResult { route: CxRouteResult; result: CxNativeExecutionResult; }
export interface CxBridgeDependencies { cwd: string; adapter: CliAdapter; }
export type { CliAdapter, ProjectContextEnvelope };
