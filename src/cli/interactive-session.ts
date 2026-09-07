import { BudgetController } from "../budget/budget-controller.ts";
import { MODEL_CONFIG, isReasoningSupported } from "../config.ts";
import { EscalationPolicy } from "../escalation/escalation-policy.ts";
import type { EscalationDecision } from "../escalation/types.ts";
import type { EscalationPolicyService } from "../orchestration/types.ts";
import { routeTask } from "../router.ts";
import type { BudgetState, UsageSnapshot } from "../budget/types.ts";
import type { ModelId, ReasoningLevel } from "../types.ts";
import type { CxAttachment, ResolvedCxAttachment } from "../types.ts";
import { AttachmentError, validateAttachments } from "../attachments.ts";
import { formatStatus } from "./format.ts";
import type { CliAdapter, CliProfile } from "./types.ts";
import { ProjectContextService } from "../project/project-context-service.ts";
import type { ProjectSnapshot } from "../project/types.ts";

export interface SessionIo { write(text: string): void; clear?(): void; }
export interface InteractiveSessionState {
  cwd: string; threadId?: string; messageCount: number; startedAt: string;
  profile: CliProfile; model?: ModelId; reasoning?: ReasoningLevel; dryRun: boolean; escalationEnabled: boolean;
  attachments: ResolvedCxAttachment[];
}

const PROFILE_STATE: Readonly<Record<Exclude<CliProfile, "auto">, Exclude<BudgetState, "unknown">>> = { balanced: "balanced", conservative: "conservative", eco: "eco", emergency: "emergency" };

class NoEscalation implements EscalationPolicyService {
  private readonly policy = new EscalationPolicy();
  public decide(input: Parameters<EscalationPolicyService["decide"]>[0]): EscalationDecision {
    const decision = this.policy.decide(input);
    return decision.action === "escalate-model"
      ? { action: "require-human-review", currentModel: decision.currentModel, reason: "Automatic model escalation is disabled.", ...(decision.failureCategory ? { failureCategory: decision.failureCategory } : {}) }
      : decision;
  }
}

/** Local REPL state. It owns thread continuity; routing remains per-message. */
export class InteractiveSession {
  public readonly state: InteractiveSessionState;
  private readonly adapter: CliAdapter;
  private readonly io: SessionIo;
  private readonly projects = new ProjectContextService();
  private project: ProjectSnapshot | undefined;

  public constructor(adapter: CliAdapter, io: SessionIo, cwd: string, initial: Partial<InteractiveSessionState> = {}) {
    this.adapter = adapter; this.io = io;
    this.state = { cwd, messageCount: 0, startedAt: new Date().toISOString(), profile: "auto", dryRun: false, escalationEnabled: true, attachments: [], ...initial };
  }

  public async start(): Promise<void> {
    this.project = this.projects.open(this.state.cwd);
    if (this.project.threads.activeThreadId) this.state.threadId = this.project.threads.activeThreadId;
    const usage = await this.usage();
    const state = this.budgetState(usage);
    this.io.write(`CX AUTO MODEL\n\nProject: ${this.state.cwd}\nUsage: ${usage.fiveHour?.remainingPercent ?? "?"}% / ${usage.weekly?.remainingPercent ?? "?"}%\nBudget: ${state.toUpperCase()}\n`);
  }

  public async handle(input: string): Promise<"continue" | "exit"> {
    const line = input.trim();
    if (!line) return "continue";
    if (line === "exit" || line === "quit" || line === "/exit") return "exit";
    if (line.startsWith("/")) return this.command(line);
    return this.message(line);
  }
  public async interrupt(): Promise<void> {
    if (!this.adapter.interruptActiveTurn) return this.io.write("No active turn.");
    this.io.write("Interrupting current turn...");
    try { this.io.write(await this.adapter.interruptActiveTurn() ? "✓ Turn interrupted" : "No active turn."); }
    catch { this.io.write("✗ Could not interrupt current turn"); }
  }

  private async command(line: string): Promise<"continue" | "exit"> {
    const [command, arg] = line.split(/\s+/, 2);
    if (command === "/help") this.io.write("/help /image <path> /images [clear] /status /project /context /threads /reindex /model /reasoning /profile /dry-run /escalation /new /clear /exit");
    else if (command === "/image") this.addImage(arg);
    else if (command === "/images") { if (arg === "clear") { this.state.attachments = []; this.io.write("Images cleared."); } else this.io.write(this.state.attachments.length ? this.state.attachments.map((item) => item.name).join("\n") : "No pending images."); }
    else if (command === "/status") { const usage = await this.usage(); this.io.write(`${formatStatus(usage, this.budgetState(usage))}\nThread: ${this.state.threadId ?? "new"}\nMessages: ${this.state.messageCount}\nOverrides: model=${this.state.model ?? "AUTO"}, reasoning=${this.state.reasoning ?? "AUTO"}, profile=${this.state.profile}`); }
    else if (command === "/project") this.io.write(`Project: ${this.project?.metadata.name}\nRoot: ${this.project?.metadata.rootPath}`);
    else if (command === "/context") this.io.write(`Stack: ${this.project?.context.stack.join(", ") || "unknown"}\nModules: ${this.project?.context.importantModules.join(", ") || "none"}`);
    else if (command === "/threads") this.io.write((this.project?.threads.threads ?? []).map((t) => `${t.threadId} ${t.status}`).join("\n") || "No known threads.");
    else if (command === "/reindex") { this.project = this.projects.open(this.state.cwd, true); this.io.write("Project context reindexed."); }
    else if (command === "/model") this.setModel(arg);
    else if (command === "/reasoning") this.setReasoning(arg);
    else if (command === "/profile") this.setProfile(arg);
    else if (command === "/dry-run") this.setBoolean("dryRun", arg);
    else if (command === "/escalation") this.setBoolean("escalationEnabled", arg);
    else if (command === "/interrupt") await this.interrupt();
    else if (command === "/new") { delete this.state.threadId; if (this.project) { delete this.project.threads.activeThreadId; this.projects.saveThreads(this.project.metadata.rootPath, this.project.threads); } this.io.write("New thread will be created by the next message."); }
    else if (command === "/clear") { this.io.clear?.(); }
    else this.io.write("Unknown command. Use /help.");
    return "continue";
  }

  private async message(prompt: string): Promise<"continue"> {
    const attachments = this.state.attachments;
    const initial = routeTask({ prompt, ...(attachments.length ? { hasVisualContext: true } : {}) });
    const selectedModel = this.state.model ?? initial.selectedModel;
    const selectedReasoning = this.state.reasoning ?? initial.reasoning;
    const usage = await this.usage();
    const routingDecision = { ...initial, selectedModel, reasoning: selectedReasoning };
    const budget = new BudgetController().evaluate({ usage, routingDecision, ...(this.state.model ? { minimumModel: this.state.model } : {}), ...(this.state.profile !== "auto" ? { budgetStateCap: PROFILE_STATE[this.state.profile] } : {}) });
    this.io.write(`${this.state.model || this.state.reasoning ? "OVERRIDE" : "AUTO"} → ${budget.preferredModel} ${selectedReasoning}\nBudget: ${budget.state}`);
    try {
      this.project ??= this.projects.open(this.state.cwd);
      const result = await this.adapter.executeAuto({ prompt: this.projects.prompt(this.projects.envelope(this.project), prompt), routingDecision, usageSnapshot: usage, ...(attachments.length ? { attachments } : {}), ...(this.state.threadId ? { threadId: this.state.threadId } : {}), ...(this.state.model ? { minimumModel: this.state.model } : {}), ...(this.state.reasoning ? { minimumReasoning: this.state.reasoning } : {}), ...(this.state.profile !== "auto" ? { budgetStateCap: PROFILE_STATE[this.state.profile] } : {}), dryRun: this.state.dryRun }, this.state.escalationEnabled ? {} : { policy: new NoEscalation() });
      this.state.attachments = [];
      this.state.messageCount++;
      const nextThread = result.finalResult?.threadId ?? result.taskExecution.threadId ?? this.state.threadId;
      if (nextThread) this.state.threadId = nextThread;
      if (this.project && nextThread) { if (!this.project.threads.threads.some((t) => t.threadId === nextThread)) this.project.threads.threads.push({ threadId: nextThread, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: "active" }); this.project.threads.activeThreadId = nextThread; this.projects.saveThreads(this.project.metadata.rootPath, this.project.threads); }
      if (result.totalAttempts > 1) this.io.write(`↻ Retry: ${result.finalModel ?? budget.preferredModel} ${result.finalReasoning ?? selectedReasoning}`);
      if (result.finalStatus === "success" || result.finalStatus === "dry-run") this.io.write("✓ Completed");
      else { if (result.finalStatus === "unavailable" && this.project) { delete this.state.threadId; delete this.project.threads.activeThreadId; this.projects.saveThreads(this.project.metadata.rootPath, this.project.threads); } this.io.write(`✗ ${result.finalStatus}\nReason: ${result.stoppedReason}`); }
    } catch (error) { this.io.write(`✗ Execution failed\nReason: ${error instanceof Error ? error.message : "Unknown error"}`); }
    return "continue";
  }

  private setModel(value: string | undefined): void {
    if (!value) return this.io.write(`Model: ${this.state.model ?? "AUTO"}`);
    if (value === "auto") { delete this.state.model; return this.io.write("Model: AUTO"); }
    if (!Object.hasOwn(MODEL_CONFIG, value)) return this.io.write("Invalid model.");
    this.state.model = value as ModelId; this.io.write(`Model: ${value}`);
  }
  private setReasoning(value: string | undefined): void {
    if (!value) return this.io.write(`Reasoning: ${this.state.reasoning ?? "AUTO"}`);
    if (value === "auto") { delete this.state.reasoning; return this.io.write("Reasoning: AUTO"); }
    if (!["low", "medium", "high", "xhigh", "max"].includes(value)) return this.io.write("Invalid reasoning level.");
    if (this.state.model && !isReasoningSupported(this.state.model, value as ReasoningLevel)) return this.io.write("Reasoning level is incompatible with the model.");
    this.state.reasoning = value as ReasoningLevel; this.io.write(`Reasoning: ${value}`);
  }
  private setProfile(value: string | undefined): void {
    if (!value) return this.io.write(`Profile: ${this.state.profile}`);
    if (!["auto", "balanced", "conservative", "eco", "emergency"].includes(value)) return this.io.write("Invalid profile.");
    this.state.profile = value as CliProfile; this.io.write(`Profile: ${value}`);
  }
  private setBoolean(key: "dryRun" | "escalationEnabled", value: string | undefined): void {
    if (!value) return this.io.write(`${key === "dryRun" ? "Dry-run" : "Escalation"}: ${this.state[key] ? "on" : "off"}`);
    if (value !== "on" && value !== "off") return this.io.write("Use on or off.");
    this.state[key] = value === "on"; this.io.write(`${key === "dryRun" ? "Dry-run" : "Escalation"}: ${value}`);
  }
  private addImage(path: string | undefined): void { try { if (!path) throw new AttachmentError("Provide an image path."); this.state.attachments.push(...validateAttachments([{ type: "image", path } as CxAttachment], this.state.cwd)); this.io.write(`Image attached: ${this.state.attachments.at(-1)?.name}`); } catch (error) { this.io.write(`✗ ${error instanceof Error ? error.message : "Invalid image."}`); } }
  private async usage(): Promise<UsageSnapshot> { try { return await this.adapter.getUsage(); } catch { return { source: "unknown", capturedAt: new Date().toISOString() }; } }
  private budgetState(usage: UsageSnapshot): BudgetState { return new BudgetController().evaluate({ usage, routingDecision: routeTask({ prompt: "status" }), ...(this.state.profile !== "auto" ? { budgetStateCap: PROFILE_STATE[this.state.profile] } : {}) }).state; }
}
