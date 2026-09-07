import { TaskExecutionHistory } from "../history/task-execution-history.ts";
import { EscalationPolicy } from "../escalation/escalation-policy.ts";
import { MODEL_CONFIG, supportedReasoningFor } from "../config.ts";
import { BudgetController } from "../budget/budget-controller.ts";
import { unknownUsageSnapshot } from "../usage/usage-snapshot.ts";
import { routeTask } from "../router.ts";
import type { CodexExecutionResult } from "../codex/types.ts";
import type { EscalationDecision } from "../escalation/types.ts";
import type { TaskExecution } from "../history/types.ts";
import type { BudgetDecision, ExecutionBudget, UsageSnapshot } from "../budget/types.ts";
import type { ClassificationResult, ModelId, ReasoningLevel } from "../types.ts";
import {
  DEFAULT_ATTEMPT_LIMITS,
  type AttemptLimits,
  type AutoModelOrchestratorDependencies,
  type AutoModelOrchestratorOptions,
  type BudgetPolicyService,
  type ExecutionService,
  type OrchestrationRequest,
  type OrchestrationResult,
  type EscalationPolicyService,
} from "./types.ts";
import type { UsageProvider } from "../usage/types.ts";

const RETRY_PROMPT = "Revisa el resultado del intento anterior. Corrige el fallo detectado y vuelve a validar la tarea.";

function strongerModel(left: ModelId, right: ModelId): ModelId {
  return MODEL_CONFIG[left].rank >= MODEL_CONFIG[right].rank ? left : right;
}

function decisionFor(
  base: ClassificationResult,
  selectedModel: ModelId,
  reasoning: ReasoningLevel,
): ClassificationResult {
  return { ...base, selectedModel, reasoning };
}

function countModelAttempts(execution: TaskExecution, model: ModelId): number {
  return execution.attempts.filter((attempt) => attempt.model.logical === model).length;
}

const REASONING_RANK: Readonly<Record<ReasoningLevel, number>> = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

function effectiveLimits(budget: ExecutionBudget, requested?: AttemptLimits): AttemptLimits {
  const fallback = requested ?? DEFAULT_ATTEMPT_LIMITS;
  return {
    maxTotalAttempts: Math.min(fallback.maxTotalAttempts, budget.maxTotalAttempts),
    perModel: {
      luna: Math.min(fallback.perModel.luna, budget.maxAttemptsPerModel.luna),
      terra: Math.min(fallback.perModel.terra, budget.maxAttemptsPerModel.terra),
      sol: Math.min(fallback.perModel.sol, budget.maxAttemptsPerModel.sol),
      astra: Math.min(fallback.perModel.astra, budget.maxAttemptsPerModel.astra),
    },
  };
}

/** Executes the existing router, executor and escalation policy with hard stop limits. */
export class AutoModelOrchestrator {
  private readonly executor: ExecutionService;
  private readonly policy: EscalationPolicyService;
  private readonly budget: BudgetPolicyService;
  private readonly usageProvider: UsageProvider | undefined;

  public constructor(
    executor: ExecutionService | AutoModelOrchestratorDependencies,
    policy: EscalationPolicyService = new EscalationPolicy(),
    budget: BudgetPolicyService = new BudgetController(),
    options: AutoModelOrchestratorOptions = {},
  ) {
    if ("executor" in executor) {
      this.executor = executor.executor;
      this.policy = executor.policy ?? policy;
      this.budget = executor.budget ?? budget;
      this.usageProvider = executor.usageProvider;
    } else {
      this.executor = executor;
      this.policy = policy;
      this.budget = budget;
      this.usageProvider = options.usageProvider;
    }
  }

  public async execute(input: OrchestrationRequest): Promise<OrchestrationResult> {
    const routingDecision = input.routingDecision ?? routeTask({
      prompt: input.prompt,
      ...(input.budgetProfile ? { budgetProfile: input.budgetProfile } : {}),
    });
    const historyBuilder = new TaskExecutionHistory();
    let taskExecution = input.taskExecution ?? historyBuilder.begin({
      prompt: input.prompt,
      routingDecision,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    let usageSnapshot = input.usageSnapshot ?? await this.usageFor(input.usageProvider ?? this.usageProvider);
    const initialBudget = this.budget.evaluate({
      ...(usageSnapshot ? { usage: usageSnapshot } : {}),
      ...(input.budgetStateCap ? { budgetStateCap: input.budgetStateCap } : {}),
      routingDecision,
      ...(input.minimumModel ? { minimumModel: input.minimumModel } : {}),
    });
    const budgetDecisions: BudgetDecision[] = [initialBudget];
    let activeBudget = initialBudget;
    let limits = effectiveLimits(activeBudget.executionBudget, input.limits);
    let currentModel = strongerModel(initialBudget.preferredModel, initialBudget.minimumModel);
    let currentReasoning = this.reasoningFor(currentModel, routingDecision.reasoning, activeBudget, input.minimumReasoning);
    let threadId = input.threadId ?? taskExecution.threadId ?? undefined;
    let prompt = input.prompt;
    let mustResolveExactModel = false;
    const escalations: EscalationDecision[] = [];
    let finalResult: CodexExecutionResult | undefined;

    while (true) {
      const limitReason = this.limitReason(taskExecution, currentModel, limits);
      if (limitReason) {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, budgetDecisions, activeBudget.executionBudget, usageSnapshot, "limit-reached", limitReason, finalResult);
      }

      const declaredMinimum = strongerModel(input.minimumModel ?? "luna", initialBudget.minimumModel);
      const minimumModel = mustResolveExactModel
        ? strongerModel(declaredMinimum, currentModel)
        : declaredMinimum;
      finalResult = await this.executor.execute({
        prompt,
        routingDecision: decisionFor(routingDecision, currentModel, currentReasoning),
        ...(threadId ? { threadId } : {}),
        minimumModel,
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
        taskExecution,
      });
      taskExecution = finalResult.taskExecution ?? historyBuilder.complete(taskExecution, finalResult);
      threadId = finalResult.threadId ?? taskExecution.threadId ?? undefined;
      currentModel = finalResult.resolvedModel ?? currentModel;
      currentReasoning = finalResult.reasoning ?? currentReasoning;

      if (input.dryRun || finalResult.status === "dry-run") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, budgetDecisions, activeBudget.executionBudget, usageSnapshot, "dry-run", "Dry-run completed without starting a turn.", finalResult);
      }
      if (finalResult.status === "not-executed") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, budgetDecisions, activeBudget.executionBudget, usageSnapshot, "unavailable", finalResult.error ?? "No permitted Codex model could be resolved.", finalResult);
      }

      const policyDecision = this.policy.decide({
        taskExecution,
        routingDecision,
        currentModel,
        ...(input.minimumModel ? { minimumModel: input.minimumModel } : {}),
        ...(input.budgetProfile ? { budgetProfile: input.budgetProfile } : {}),
      });
      escalations.push(policyDecision);

      if (policyDecision.action === "stop-success") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, budgetDecisions, activeBudget.executionBudget, usageSnapshot, "success", policyDecision.reason, finalResult);
      }
      if (policyDecision.action === "stop-failure") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, budgetDecisions, activeBudget.executionBudget, usageSnapshot, "failed", policyDecision.reason, finalResult);
      }
      if (policyDecision.action === "require-human-review") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, budgetDecisions, activeBudget.executionBudget, usageSnapshot, "human-review", policyDecision.reason, finalResult);
      }

      if (!policyDecision.nextModel || !policyDecision.nextReasoning) {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, budgetDecisions, activeBudget.executionBudget, usageSnapshot, "failed", "Escalation policy returned an incomplete continuation decision.", finalResult);
      }

      const continuationRouting = decisionFor(routingDecision, policyDecision.nextModel, policyDecision.nextReasoning);
      if (input.refreshUsageAfterCostlyEscalation && policyDecision.action === "escalate-model" && MODEL_CONFIG[policyDecision.nextModel].rank >= MODEL_CONFIG.sol.rank && !input.usageSnapshot) {
        usageSnapshot = await this.usageFor(input.usageProvider ?? this.usageProvider);
      }
      const continuationBudget = this.budget.evaluate({
        ...(usageSnapshot ? { usage: usageSnapshot } : {}),
        ...(input.budgetStateCap ? { budgetStateCap: input.budgetStateCap } : {}),
        routingDecision: continuationRouting,
        ...(input.minimumModel ? { minimumModel: input.minimumModel } : {}),
        escalation: policyDecision,
      });
      budgetDecisions.push(continuationBudget);
      if (continuationBudget.preferredModel !== policyDecision.nextModel || !this.allowsEscalation(policyDecision, continuationBudget, input.minimumModel)) {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, budgetDecisions, activeBudget.executionBudget, usageSnapshot, "human-review", "Execution budget restricted the requested escalation.", finalResult);
      }
      activeBudget = continuationBudget;
      limits = effectiveLimits(activeBudget.executionBudget, input.limits);
      currentModel = continuationBudget.preferredModel;
      currentReasoning = this.reasoningFor(currentModel, policyDecision.nextReasoning, continuationBudget, input.minimumReasoning);
      prompt = RETRY_PROMPT;
      mustResolveExactModel = policyDecision.action === "escalate-model";
    }
  }

  private limitReason(execution: TaskExecution, model: ModelId, limits: AttemptLimits): string | null {
    if (execution.attempts.length >= limits.maxTotalAttempts) {
      return `Global attempt limit (${limits.maxTotalAttempts}) reached.`;
    }
    if (countModelAttempts(execution, model) >= limits.perModel[model]) {
      return `${model} attempt limit (${limits.perModel[model]}) reached.`;
    }
    return null;
  }

  private result(
    taskExecution: TaskExecution,
    finalModel: ModelId | null,
    finalReasoning: ReasoningLevel | null,
    escalations: EscalationDecision[],
    budgetDecisions: BudgetDecision[],
    executionBudget: ExecutionBudget,
    usageSnapshot: UsageSnapshot,
    finalStatus: OrchestrationResult["finalStatus"],
    stoppedReason: string,
    finalResult?: CodexExecutionResult,
  ): OrchestrationResult {
    return {
      taskExecution,
      finalStatus,
      finalModel,
      finalReasoning,
      totalAttempts: taskExecution.attempts.length,
      escalations,
      budgetDecisions,
      budgetState: executionBudget.state,
      executionBudget,
      usageSnapshot,
      ...(finalResult ? { finalResult } : {}),
      stoppedReason,
    };
  }

  private reasoningFor(model: ModelId, requested: ReasoningLevel, budget: BudgetDecision, minimum?: ReasoningLevel): ReasoningLevel {
    const cap = budget.executionBudget.reasoningCaps[model];
    const capped = cap && REASONING_RANK[cap] < REASONING_RANK[requested] ? cap : requested;
    const effective = minimum && REASONING_RANK[minimum] > REASONING_RANK[capped] ? minimum : capped;
    return supportedReasoningFor(model, effective);
  }

  private allowsEscalation(decision: EscalationDecision, budget: BudgetDecision, minimum?: ModelId): boolean {
    const target = decision.nextModel;
    if (!target || decision.action !== "escalate-model") return true;
    if (minimum && MODEL_CONFIG[target].rank <= MODEL_CONFIG[minimum].rank) return true;
    if (target === "astra") return budget.executionBudget.allowAutomaticEscalationToAstra || (budget.executionBudget.state === "conservative" && decision.failureCategory === "critical");
    if (target === "sol") {
      return budget.executionBudget.allowAutomaticEscalationToSol
        || decision.failureCategory === "critical"
        || (budget.executionBudget.state === "eco" && decision.failureCategory === "complexity");
    }
    return true;
  }

  private async usageFor(provider: UsageProvider | undefined): Promise<UsageSnapshot> {
    if (!provider) return unknownUsageSnapshot();
    try {
      return await provider.getUsage();
    } catch {
      return unknownUsageSnapshot();
    }
  }
}
