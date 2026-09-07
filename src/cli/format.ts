import type { CliTaskOutput } from "./types.ts";
import type { UsageSnapshot } from "../budget/types.ts";

function usageLines(usage: UsageSnapshot): string[] {
  return [
    `5h: ${usage.fiveHour ? `${usage.fiveHour.remainingPercent}%` : "unavailable"}`,
    `Weekly: ${usage.weekly ? `${usage.weekly.remainingPercent}%` : "unavailable"}`,
    ...(usage.creditsRemaining !== undefined ? [`Credits: ${usage.creditsRemaining}`] : []),
  ];
}

export function formatStatus(usage: UsageSnapshot, state: string): string {
  return ["CODEX STATUS", "", ...usageLines(usage), ...(usage.fiveHour?.resetsAt ? [`5h reset: ${usage.fiveHour.resetsAt}`] : []), ...(usage.weekly?.resetsAt ? [`Weekly reset: ${usage.weekly.resetsAt}`] : []), `Budget: ${state.toUpperCase()}`].join("\n");
}

export function formatTask(output: CliTaskOutput): string {
  const result = output.orchestrationResult;
  const lines = [
    "AUTO MODEL", "",
    `Task: ${output.task.domain}`,
    `Complexity: ${output.task.complexity}`,
    `Risk: ${output.task.risk}`,
    "", "Usage:", ...usageLines(output.usageSnapshot), "",
    `Budget: ${output.budgetState.toUpperCase()}`,
    `Selected: ${output.selectedModel ?? "unavailable"}${output.reasoning ? ` ${output.reasoning}` : ""}`,
  ];
  if (output.attachments?.length) lines.push(`Visual context: ${output.attachments.length} image${output.attachments.length === 1 ? "" : "s"}`);
  const overrides = Object.entries(output.overrides).filter(([, value]) => value !== undefined);
  if (overrides.length) lines.push(`Overrides: ${overrides.map(([key, value]) => `${key}=${value}`).join(", ")}`);
  if (result) {
    if (result.finalStatus === "dry-run") {
      const limits = Object.entries(result.executionBudget.maxAttemptsPerModel).map(([model, attempts]) => `${model}=${attempts}`).join(", ");
      lines.push(`Execution budget: ${result.executionBudget.maxTotalAttempts} total attempts`, `Limits: ${limits}`, `Restrictions: ${result.executionBudget.reasons.join(" ")}`);
    }
    for (const attempt of result.taskExecution.attempts) lines.push(`Attempt ${attempt.sequence}: ${attempt.model.logical ?? "unavailable"} ${attempt.reasoning ?? ""} — ${attempt.status}`.trim());
    lines.push("", `Final model: ${result.finalModel ?? "unavailable"}`, `Total attempts: ${result.totalAttempts}`, `Status: ${result.finalStatus}`);
  }
  return lines.join("\n");
}
