import { MODEL_CONFIG } from "../config.ts";
import type { ModelId, ReasoningLevel } from "../types.ts";
import type {
  BudgetDecision,
  BudgetEvaluationInput,
  BudgetState,
  BudgetThresholds,
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

function reasoningCap(model: ModelId, state: BudgetState, solRequired: boolean): ReasoningLevel | undefined {
  if (state === "balanced") return undefined;
  if (model === "astra") return "xhigh";
  if (model === "sol") return solRequired ? "high" : "medium";
  if (model === "terra") return "medium";
  return state === "emergency" ? "low" : "medium";
}

/** A pure quota policy. Snapshot collection remains outside this module. */
export class BudgetController {
  private readonly thresholds: BudgetThresholds;

  public constructor(thresholds: BudgetThresholds = DEFAULT_BUDGET_THRESHOLDS) {
    validateThresholds(thresholds);
    this.thresholds = thresholds;
  }

  public evaluate(input: BudgetEvaluationInput): BudgetDecision {
    const state = stateFor(input.usage, this.thresholds);
    const originalModel = input.routingDecision.selectedModel;
    const critical = isCritical(input);
    const minimumModel = critical ? strongerModel(input.minimumModel ?? "luna", "sol") : input.minimumModel ?? "luna";
    const solRequired = justifiedSol(input, minimumModel);
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

    const cap = reasoningCap(preferredModel, state, solRequired);
    return {
      state,
      originalModel,
      preferredModel,
      minimumModel,
      allowSol: atLeast(preferredModel, "sol") || solRequired,
      allowAstra: preferredModel === "astra" || minimumModel === "astra",
      ...(cap ? { reasoningCap: cap } : {}),
      reasons,
    };
  }
}

export function evaluateBudget(input: BudgetEvaluationInput): BudgetDecision {
  return new BudgetController().evaluate(input);
}
