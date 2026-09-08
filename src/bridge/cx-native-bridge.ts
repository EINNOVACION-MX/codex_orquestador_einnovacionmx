import { BudgetController } from "../budget/budget-controller.ts";
import { existsSync, statSync } from "node:fs";
import { validateAttachments } from "../attachments.ts";
import type { CxAttachment } from "../types.ts";
import { routeTask } from "../router.ts";
import { ProjectContextService } from "../project/project-context-service.ts";
import type { UsageSnapshot } from "../budget/types.ts";
import type { CxBridgeDependencies, CxExecuteResult, CxNativeExecutionResult, CxProjectResult, CxRouteResult } from "./types.ts";
import { CodexCapabilityRegistry } from "../capabilities/codex-capability-registry.ts";
import { cxAgentCapabilities } from "../agents/cx-agent-registry.ts";

const unknownUsage = (): UsageSnapshot => ({ source: "unknown", capturedAt: new Date().toISOString() });

/** Native-tool facade. It shares exactly the same project store and orchestration adapter as cx. */
export class CxNativeBridge {
  private readonly projects = new ProjectContextService();
  private readonly dependencies: CxBridgeDependencies;
  public constructor(dependencies: CxBridgeDependencies) { if (!dependencies.cwd.trim() || !existsSync(dependencies.cwd) || !statSync(dependencies.cwd).isDirectory()) throw new CxBridgeError("CX requires a valid workspace directory."); this.dependencies = dependencies; }

  public async route(task: string, attachments?: CxAttachment[]): Promise<CxRouteResult> {
    if (!task.trim()) throw new CxBridgeError("A task is required.");
    const validated = validateAttachments(attachments, this.dependencies.cwd);
    const decision = routeTask({ prompt: task, ...(validated.length ? { hasVisualContext: true } : {}) });
    const usage = await this.usage();
    const budget = new BudgetController().evaluate({ usage, routingDecision: decision });
    return { domain: decision.domain, taskType: decision.taskType, complexity: decision.complexity, risk: decision.risk, usage, budget: budget.state, selectedModel: budget.preferredModel, reasoning: decision.reasoning, reasons: [...decision.reasons.slice(0, 4), ...budget.reasons.slice(0, 2)], executionBudget: budget.executionBudget, ...(decision.hasVisualContext ? { hasVisualContext: true } : {}) };
  }
  public async execute(task: string, attachments?: CxAttachment[]): Promise<CxExecuteResult> {
    const validated = validateAttachments(attachments, this.dependencies.cwd);
    const route = await this.route(task, attachments);
    const snapshot = this.projects.open(this.dependencies.cwd);
    const activeThreadId = snapshot.threads.activeThreadId;
    let orchestration;
    try { orchestration = await this.dependencies.adapter.executeAuto({ prompt: this.projects.prompt(this.projects.envelope(snapshot), task), routingDecision: routeTask({ prompt: task, ...(validated.length ? { hasVisualContext: true } : {}) }), usageSnapshot: route.usage, ...(validated.length ? { attachments: validated } : {}), ...(activeThreadId ? { threadId: activeThreadId } : {}) }); }
    catch (error) { throw new CxBridgeError(`CX execution unavailable: ${error instanceof Error ? error.message : "App Server error"}`); }
    const threadId = orchestration.finalResult?.threadId ?? orchestration.taskExecution.threadId;
    if (threadId) { snapshot.threads.activeThreadId = threadId; if (!snapshot.threads.threads.some((thread) => thread.threadId === threadId)) snapshot.threads.threads.push({ threadId, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: "active" }); this.projects.saveThreads(snapshot.metadata.rootPath, snapshot.threads); }
    else if (activeThreadId && (orchestration.finalStatus === "unavailable" || /invalid|not found/i.test(orchestration.stoppedReason))) { delete snapshot.threads.activeThreadId; this.projects.saveThreads(snapshot.metadata.rootPath, snapshot.threads); }
    return { route, result: this.nativeResult(snapshot.metadata.name, route, orchestration, threadId) };
  }
  public async status(): Promise<{ usage: UsageSnapshot; budget: ReturnType<BudgetController["evaluate"]>["state"] }> { const usage = await this.usage(); return { usage, budget: new BudgetController().evaluate({ usage, routingDecision: routeTask({ prompt: "status" }) }).state }; }
  public project(): CxProjectResult { const snapshot = this.projects.open(this.dependencies.cwd); return { metadata: snapshot.metadata, reindexed: snapshot.reindexed, ...(snapshot.threads.activeThreadId ? { activeThreadId: snapshot.threads.activeThreadId } : {}), threadCount: snapshot.threads.threads.length }; }
  public context() { const snapshot = this.projects.open(this.dependencies.cwd); return this.projects.envelope(snapshot); }
  /** Shared inventory for the CLI and the native MCP bridge. No model turn is started. */
  public async capabilities() {
    let snapshot;
    try {
      snapshot = this.dependencies.adapter.discoverCapabilities
        ? await this.dependencies.adapter.discoverCapabilities(this.dependencies.cwd)
        : await new CodexCapabilityRegistry({ discoverModels: async () => [] }).discover(this.dependencies.cwd);
    } catch {
      snapshot = await new CodexCapabilityRegistry({ discoverModels: async () => [] }).discover(this.dependencies.cwd);
    }
    return { ...snapshot, agents: [...snapshot.agents, ...cxAgentCapabilities()] };
  }
  public agents() { return { native: [{ id: "native-agents", name: "Codex Native Agents", available: false, description: "No public agent-list endpoint is exposed by this App Server version." }], cx: cxAgentCapabilities() }; }
  private async usage(): Promise<UsageSnapshot> { try { return await this.dependencies.adapter.getUsage(); } catch { return unknownUsage(); } }
  private nativeResult(project: string, route: CxRouteResult, orchestration: Awaited<ReturnType<CxBridgeDependencies["adapter"]["executeAuto"]>>, threadId: string | null): CxNativeExecutionResult {
    const escalations = orchestration.escalations.filter((item) => item.action === "escalate-model" && item.nextModel).map((item) => `${item.currentModel} → ${item.nextModel}${item.nextReasoning ? ` ${item.nextReasoning}` : ""}`);
    const summary = orchestration.finalStatus === "success" ? "CX execution completed." : orchestration.finalStatus === "dry-run" ? "CX dry-run completed without a turn." : `CX execution ${orchestration.finalStatus}: ${orchestration.stoppedReason.slice(0, 180)}`;
    return { project, taskType: route.taskType, selectedModel: orchestration.finalModel, reasoning: orchestration.finalReasoning, budgetState: orchestration.budgetState, attempts: orchestration.totalAttempts, escalations, status: orchestration.finalStatus, summary, ...(threadId ? { threadId } : {}) };
  }
}
export class CxBridgeError extends Error { public constructor(message: string) { super(message); this.name = "CxBridgeError"; } }
