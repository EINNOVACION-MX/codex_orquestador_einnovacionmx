import type { EscalationDecision } from "../escalation/types.ts";
import type { ModelId, ReasoningLevel, ClassificationResult } from "../types.ts";

export interface UsageWindow {
  remainingPercent: number;
  resetsAt?: string;
}

export interface UsageSnapshot {
  source: "manual" | "codex-cli" | "unknown";
  capturedAt: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  creditsRemaining?: number;
}

export type BudgetState = "balanced" | "conservative" | "eco" | "emergency" | "unknown";

export interface BudgetThresholds {
  balancedAt: number;
  conservativeAt: number;
  ecoAt: number;
}

export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {
  balancedAt: 70,
  conservativeAt: 40,
  ecoAt: 20,
};

export interface BudgetEvaluationInput {
  usage?: UsageSnapshot;
  routingDecision: ClassificationResult;
  minimumModel?: ModelId;
  escalation?: EscalationDecision;
}

export interface BudgetDecision {
  state: BudgetState;
  originalModel: ModelId;
  preferredModel: ModelId;
  minimumModel: ModelId;
  allowSol: boolean;
  allowAstra: boolean;
  reasoningCap?: ReasoningLevel;
  reasons: string[];
}
