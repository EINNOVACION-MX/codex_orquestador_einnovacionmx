import { MODEL_CONFIG } from "../config.ts";
import type { ModelId, ReasoningLevel } from "../types.ts";
import type {
  BudgetDecision,
  BudgetEvaluationInput,
  BudgetState,
  BudgetThresholds,
  ExecutionBudget,
  UsageSnapshot,
} from "./types.ts";
import { DEFAULT_BUDGET_THRESHOLDS } from "./types.ts";

function strongerModel(left: ModelId, right: ModelId): ModelId {
  return MODEL_CONFIG[left].rank >= MODEL_CONFIG[right].rank ? left : right;
}

function atLeast(model: ModelId, minimum: ModelId): boolean {
  return MODEL_CONFIG[model].rank >= MODEL_CONFIG[minimum].rank;
}

function validatePercent(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${field} must be a percentage between 0 and 100.`);
  }
}

function validateSnapshot(snapshot: UsageSnapshot): void {
  if (snapshot.fiveHour) validatePercent(snapshot.fiveHour.remainingPercent, "fiveHour.remainingPercent");
  if (snapshot.weekly) validatePercent(snapshot.weekly.remainingPercent, "weekly.remainingPercent");
}

function validateThresholds(thresholds: BudgetThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) validatePercent(value, name);
  if (!(thresholds.balancedAt > thresholds.conservativeAt && thresholds.conservativeAt > thresholds.ecoAt)) {
    throw new RangeError("Budget thresholds must descend: balancedAt > conservativeAt > ecoAt.");
  }
}

function stateFor(usage: UsageSnapshot | undefined, thresholds: BudgetThresholds): BudgetState {
  if (!usage || (!usage.fiveHour && !usage.weekly)) return "unknown";
  validateSnapshot(usage);
  const remaining = [usage.fiveHour?.remainingPercent, usage.weekly?.remainingPercent]
    .filter((value): value is number => value !== undefined);
  const lowest = Math.min(...remaining);
  if (lowest >= thresholds.balancedAt) return "balanced";
  if (lowest >= thresholds.conservativeAt) return "conservative";
  if (lowest >= thresholds.ecoAt) return "eco";
  return "emergency";
}

const STATE_RANK: Readonly<Record<BudgetState, number>> = { balanced: 0, conservative: 1, unknown: 1, eco: 2, emergency: 3 };

function restrictedState(measured: BudgetState, cap: BudgetEvaluationInput["budgetStateCap"]): BudgetState {
  if (!cap || STATE_RANK[measured] >= STATE_RANK[cap]) return measured;
  return cap;
}

function isCritical(input: BudgetEvaluationInput): boolean {
  const routing = input.routingDecision;
  return (
    (routing.domain === "cybersecurity" && routing.risk >= 4) ||
    (routing.domain === "architecture" && routing.risk >= 5) ||
    input.escalation?.failureCategory === "critical"
  );
}

function justifiedSol(input: BudgetEvaluationInput, minimum: ModelId): boolean {
  return (
    atLeast(minimum, "sol") ||
    isCritical(input) ||
    input.escalation?.failureCategory === "complexity" ||
    input.escalation?.failureCategory === "critical"
  );
}

function executionBudget(state: BudgetState, minimumModel: ModelId): ExecutionBudget {
  const conservative = state === "conservative" || state === "unknown";
  if (state === "balanced") return {
    state, reasoningCaps: {}, maxAttemptsPerModel: { luna: 2, terra: 2, sol: 2, astra: 1 }, maxTotalAttempts: 5,
    allowAutomaticEscalationToSol: true, allowAutomaticEscalationToAstra: true,
    reasons: ["Balanced usage permits the normal retry and escalation budget."],
  };
  if (conservative) return {
    state, reasoningCaps: { luna: "medium", terra: "high", sol: "high" }, maxAttemptsPerModel: { luna: 2, terra: 2, sol: 1, astra: 1 }, maxTotalAttempts: 4,
    allowAutomaticEscalationToSol: true, allowAutomaticEscalationToAstra: false,
    reasons: [state === "unknown" ? "Usage is unavailable; applying conservative execution limits." : "Conservative usage limits Astra and reduces retries."],
  };
  if (state === "eco") return {
    state, reasoningCaps: { luna: "medium", terra: "medium", sol: "medium" }, maxAttemptsPerModel: { luna: 2, terra: 2, sol: 1, astra: minimumModel === "astra" ? 1 : 0 }, maxTotalAttempts: 3,
    allowAutomaticEscalationToSol: false, allowAutomaticEscalationToAstra: false,
    reasons: ["Eco usage reserves Sol for required complexity and disables automatic Astra."],
  };
  return {
    state, reasoningCaps: { luna: "medium", terra: "medium", sol: "medium" }, maxAttemptsPerModel: { luna: 1, terra: 1, sol: 1, astra: minimumModel === "astra" ? 1 : 0 }, maxTotalAttempts: 2,
    allowAutomaticEscalationToSol: false, allowAutomaticEscalationToAstra: false,
    reasons: ["Emergency usage allows only the minimum required execution."],
  };
}

/** A pure quota policy. Snapshot collection remains outside this module. */
export class BudgetController {
  private readonly thresholds: BudgetThresholds;

  public constructor(thresholds: BudgetThresholds = DEFAULT_BUDGET_THRESHOLDS) {
    validateThresholds(thresholds);
    this.thresholds = thresholds;
  }

  public evaluate(input: BudgetEvaluationInput): BudgetDecision {
    const measuredState = stateFor(input.usage, this.thresholds);
    const state = restrictedState(measuredState, input.budgetStateCap);
    const originalModel = input.routingDecision.selectedModel;
    const critical = isCritical(input);
    const minimumModel = critical ? strongerModel(input.minimumModel ?? "luna", "sol") : input.minimumModel ?? "luna";
    const solRequired = justifiedSol(input, minimumModel);
    const budget = executionBudget(state, minimumModel);
    const reasons: string[] = [];
    let preferredModel = originalModel;

    if (state === "unknown") reasons.push("Usage is unavailable; applying conservative behavior.");
    if (state === "conservative" || state === "unknown") {
      if (preferredModel === "astra" && minimumModel !== "astra" && !critical) {
        preferredModel = solRequired ? "sol" : "terra";
        reasons.push("Astra is restricted in conservative mode.");
      }
      if (preferredModel === "sol" && !solRequired) {
        preferredModel = "terra";
        reasons.push("Sol is reserved for required complexity or risk.");
      }
    }

    if (state === "eco" || state === "emergency") {
      if (preferredModel === "astra" && minimumModel !== "astra") {
        preferredModel = solRequired ? "sol" : "terra";
        reasons.push("Astra is not selected automatically under constrained usage.");
      }
      if (preferredModel === "sol" && !solRequired) {
        preferredModel = "terra";
        reasons.push("Sol is restricted until capability or risk requires it.");
      }
      if (state === "emergency") reasons.push("Emergency mode preserves quota for required work.");
    }

    if (!atLeast(preferredModel, minimumModel)) {
      preferredModel = minimumModel;
      reasons.push("minimumModel prevents a lower-capability budget downgrade.");
    }
    if (critical && preferredModel !== "sol" && preferredModel !== "astra") {
      preferredModel = "sol";
      reasons.push("Critical security or architecture work requires Sol or higher.");
    }
    if (reasons.length === 0) reasons.push("Budget state permits the routed model.");

    const cap = budget.reasoningCaps[preferredModel];
    return {
      state,
      originalModel,
      preferredModel,
      minimumModel,
      allowSol: atLeast(preferredModel, "sol") || solRequired,
      allowAstra: preferredModel === "astra" || minimumModel === "astra",
      ...(cap ? { reasoningCap: cap } : {}),
      executionBudget: budget,
      reasons,
    };
  }
}

export function evaluateBudget(input: BudgetEvaluationInput): BudgetDecision {
  return new BudgetController().evaluate(input);
}
