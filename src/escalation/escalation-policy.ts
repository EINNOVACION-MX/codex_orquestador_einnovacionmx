import {
  BUDGET_PROFILE_CONFIG,
  DEFAULT_BUDGET_PROFILE,
  MODEL_CONFIG,
  supportedReasoningFor,
} from "../config.ts";
import type { BudgetProfileName, ModelId, ReasoningLevel } from "../types.ts";
import type { AttemptRecord } from "../history/types.ts";
import type {
  EscalationDecision,
  EscalationPolicyInput,
  FailureCategory,
} from "./types.ts";

const NEXT_MODEL: Readonly<Record<ModelId, ModelId | null>> = {
  luna: "terra",
  terra: "sol",
  sol: "astra",
  astra: null,
};

const ESCALATION_REASONING: Readonly<Record<ModelId, ReasoningLevel>> = {
  luna: "low",
  terra: "medium",
  sol: "high",
  astra: "xhigh",
};

const INFRASTRUCTURE_PATTERN = /app[ -]?server|network|connection|timeout|timed out|process not found|enoent|environment|tool failure|unavailable/i;
const COMPLEXITY_PATTERN = /cannot|can't|unable|incapaz|no puedo|too complex|complej[ia]d|beyond.*capability/i;
const CRITICAL_PATTERN = /security|seguridad|data corruption|corrupci[oó]n.*datos|destructive migration|migraci[oó]n destructiva|race condition/i;

function messageFor(attempt: AttemptRecord): string {
  return [
    attempt.error,
    attempt.finalResult.summary,
    attempt.testResult?.summary,
  ].filter((value): value is string => Boolean(value)).join(" ");
}

function isCriticalTask(input: EscalationPolicyInput, attempt: AttemptRecord): boolean {
  const promptAndError = `${input.taskExecution.prompt} ${messageFor(attempt)}`;
  return (
    CRITICAL_PATTERN.test(promptAndError) ||
    (input.routingDecision.domain === "cybersecurity" && input.routingDecision.risk >= 4) ||
    (input.routingDecision.domain === "architecture" && input.routingDecision.risk >= 5)
  );
}

function repeatedFailure(attempts: readonly AttemptRecord[], lastAttempt: AttemptRecord): boolean {
  const failures = attempts.filter((attempt) => attempt.status !== "success");
  const lastMessage = messageFor(lastAttempt).trim().toLowerCase().replace(/\s+/g, " ");
  const sameStatus = failures.filter((attempt) => attempt.status === lastAttempt.status).length >= 2;
  const sameMessage = lastMessage.length > 0 && failures.filter(
    (attempt) => messageFor(attempt).trim().toLowerCase().replace(/\s+/g, " ") === lastMessage,
  ).length >= 2;
  return sameStatus || sameMessage || failures.length >= 3;
}

function categoryFor(input: EscalationPolicyInput, attempt: AttemptRecord): FailureCategory {
  const message = messageFor(attempt);
  if (attempt.status === "timeout" || INFRASTRUCTURE_PATTERN.test(message)) return "infrastructure";
  if (isCriticalTask(input, attempt)) return "critical";
  if (repeatedFailure(input.taskExecution.attempts, attempt) || COMPLEXITY_PATTERN.test(message)) {
    return "complexity";
  }
  if (attempt.status === "test-failure" || /compil|lint|format|type error|implement/i.test(message)) {
    return "recoverable";
  }
  return "unknown";
}

function modelAtLeast(model: ModelId, minimum: ModelId): boolean {
  return MODEL_CONFIG[model].rank >= MODEL_CONFIG[minimum].rank;
}

function largerModel(left: ModelId, right: ModelId): ModelId {
  return MODEL_CONFIG[left].rank >= MODEL_CONFIG[right].rank ? left : right;
}

function canUseModel(
  model: ModelId,
  profile: BudgetProfileName,
  category: FailureCategory,
): boolean {
  const budget = BUDGET_PROFILE_CONFIG[profile];
  if (MODEL_CONFIG[model].rank <= MODEL_CONFIG[budget.maximumAutomaticModel].rank) return true;
  return model === "astra" && category === "critical" && budget.allowCriticalAstraEscalation;
}

function nextReasoning(
  model: ModelId,
  previous: ReasoningLevel | null,
  preservePrevious = false,
): ReasoningLevel {
  return supportedReasoningFor(
    model,
    preservePrevious ? previous ?? ESCALATION_REASONING[model] : ESCALATION_REASONING[model],
  );
}

export class EscalationPolicy {
  public decide(input: EscalationPolicyInput): EscalationDecision {
    const lastAttempt = input.lastAttempt ?? input.taskExecution.attempts.at(-1);
    if (input.taskExecution.finalStatus === "success" || lastAttempt?.status === "success") {
      return {
        action: "stop-success",
        currentModel: input.currentModel,
        reason: "The latest attempt completed successfully.",
      };
    }
    if (!lastAttempt) {
      return {
        action: "stop-failure",
        currentModel: input.currentModel,
        reason: "No execution attempt is available to evaluate.",
        failureCategory: "unknown",
      };
    }
    if (lastAttempt.status === "interrupted") {
      return { action: "stop-failure", currentModel: input.currentModel, reason: "A manually interrupted turn is not retried or escalated." };
    }

    const category = categoryFor(input, lastAttempt);
    const requiredMinimum = category === "critical"
      ? largerModel(input.minimumModel ?? "luna", "sol")
      : input.minimumModel ?? "luna";
    const profile = input.budgetProfile ?? DEFAULT_BUDGET_PROFILE;

    if (category === "infrastructure") {
      return {
        action: "require-human-review",
        currentModel: input.currentModel,
        reason: "Infrastructure failures require environment recovery, not a stronger model.",
        failureCategory: category,
      };
    }

    if (!modelAtLeast(input.currentModel, requiredMinimum)) {
      return this.escalate(input.currentModel, requiredMinimum, lastAttempt.reasoning, category, profile,
        "The task requires the configured minimum model capability.");
    }

    if (category === "recoverable") {
      return {
        action: "retry-same-model",
        currentModel: input.currentModel,
        nextModel: input.currentModel,
        nextReasoning: nextReasoning(input.currentModel, lastAttempt.reasoning, true),
        reason: "The first recoverable failure can be retried with the same model.",
        failureCategory: category,
      };
    }

    if (category === "complexity" || category === "critical") {
      const candidate = category === "critical" ? requiredMinimum : NEXT_MODEL[input.currentModel];
      if (!candidate || MODEL_CONFIG[candidate].rank <= MODEL_CONFIG[input.currentModel].rank) {
        return {
          action: "require-human-review",
          currentModel: input.currentModel,
          reason: "No higher logical model is available for this persistent failure.",
          failureCategory: category,
        };
      }
      return this.escalate(input.currentModel, candidate, lastAttempt.reasoning, category, profile,
        category === "critical" ? "Critical risk requires at least Sol." : "Repeated or complex failures merit a stronger model.");
    }

    return {
      action: "require-human-review",
      currentModel: input.currentModel,
      reason: "The failure cannot be classified safely for automatic escalation.",
      failureCategory: category,
    };
  }

  private escalate(
    currentModel: ModelId,
    candidate: ModelId,
    previousReasoning: ReasoningLevel | null,
    category: FailureCategory,
    profile: BudgetProfileName,
    reason: string,
  ): EscalationDecision {
    if (!canUseModel(candidate, profile, category)) {
      return {
        action: "require-human-review",
        currentModel,
        reason: `${reason} The ${profile} budget profile does not allow ${candidate}.`,
        failureCategory: category,
      };
    }
    return {
      action: "escalate-model",
      currentModel,
      nextModel: candidate,
      nextReasoning: nextReasoning(candidate, previousReasoning),
      reason,
      failureCategory: category,
    };
  }
}

export function decideEscalation(input: EscalationPolicyInput): EscalationDecision {
  return new EscalationPolicy().decide(input);
}
