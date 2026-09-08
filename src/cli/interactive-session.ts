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
import { CX_IDENTITY, formatAbout } from "./identity.ts";
import { CodexCapabilityRegistry, CX_COMMANDS } from "../capabilities/codex-capability-registry.ts";
import type { CodexCapabilitySnapshot } from "../capabilities/types.ts";
import { CX_AGENTS, getCxAgent, strongerModel, type CxAgentId } from "../agents/cx-agent-registry.ts";

export interface SessionIo { write(text: string): void; clear?(): void; }
export interface InteractiveSessionState {
  cwd: string; threadId?: string; messageCount: number; startedAt: string;
  profile: CliProfile; model?: ModelId; reasoning?: ReasoningLevel; dryRun: boolean; escalationEnabled: boolean;
  attachments: ResolvedCxAttachment[]; agent: CxAgentId;
}
export interface InteractivePresentation {
  projectName: string; model?: ModelId; reasoning?: ReasoningLevel; profile: CliProfile; budgetState: BudgetState;
  fiveHourRemaining?: number; weeklyRemaining?: number; threadId?: string; pendingImages: string[]; version: string; agent: string;
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
  private lastUsage: UsageSnapshot | undefined;
  private lastBudgetState: BudgetState = "unknown";
  private capabilities: CodexCapabilitySnapshot | undefined;

  public constructor(adapter: CliAdapter, io: SessionIo, cwd: string, initial: Partial<InteractiveSessionState> = {}) {
    this.adapter = adapter; this.io = io;
    this.state = { cwd, messageCount: 0, startedAt: new Date().toISOString(), profile: "auto", dryRun: false, escalationEnabled: true, attachments: [], agent: "auto", ...initial };
  }

  public async start(showStartup = true): Promise<void> {
    this.project = this.projects.open(this.state.cwd);
    if (this.project.threads.activeThreadId) this.state.threadId = this.project.threads.activeThreadId;
    this.restorePreferences();
    const usage = await this.usage();
    const state = this.budgetState(usage);
    this.lastBudgetState = state;
    if (showStartup) this.io.write(`${CX_IDENTITY.name}\nfor OpenAI Codex\n\nDeveloped by ${CX_IDENTITY.developer}\nOpen Source\n\nProject: ${this.project.metadata.name}\nModel: ${this.state.model?.toUpperCase() ?? "AUTO"}\nBudget: ${state.toUpperCase()}\nUsage: 5h ${usage.fiveHour?.remainingPercent ?? "?"}% | Weekly ${usage.weekly?.remainingPercent ?? "?"}%\n`);
  }
  public presentation(): InteractivePresentation {
    return { projectName: this.project?.metadata.name ?? this.state.cwd, ...(this.state.model ? { model: this.state.model } : {}), ...(this.state.reasoning ? { reasoning: this.state.reasoning } : {}), profile: this.state.profile, budgetState: this.lastBudgetState, ...(this.lastUsage?.fiveHour ? { fiveHourRemaining: this.lastUsage.fiveHour.remainingPercent } : {}), ...(this.lastUsage?.weekly ? { weeklyRemaining: this.lastUsage.weekly.remainingPercent } : {}), ...(this.state.threadId ? { threadId: this.state.threadId } : {}), pendingImages: this.state.attachments.map((item) => item.name), version: CX_IDENTITY.version, agent: getCxAgent(this.state.agent)?.name ?? "AUTO" };
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
    if (command === "/help") this.io.write(`COMMANDS\n\n${CX_COMMANDS.map((item) => `${item.command.padEnd(12)} ${item.description}`).join("\n")}`);
    else if (command === "/about") this.io.write(formatAbout());
    else if (command === "/image") this.addImage(arg);
    else if (command === "/images") { if (arg === "clear") { this.state.attachments = []; this.io.write("Images cleared."); } else this.io.write(this.state.attachments.length ? this.state.attachments.map((item) => item.name).join("\n") : "No pending images."); }
    else if (command === "/status") { const usage = await this.usage(); this.io.write(`${formatStatus(usage, this.budgetState(usage))}\nThread: ${this.state.threadId ?? "new"}\nMessages: ${this.state.messageCount}\nOverrides: model=${this.state.model ?? "AUTO"}, reasoning=${this.state.reasoning ?? "AUTO"}, profile=${this.state.profile}`); }
    else if (command === "/project") this.io.write(`Project: ${this.project?.metadata.name}\nRoot: ${this.project?.metadata.rootPath}`);
    else if (command === "/context") this.io.write(`Stack: ${this.project?.context.stack.join(", ") || "unknown"}\nModules: ${this.project?.context.importantModules.join(", ") || "none"}`);
    else if (command === "/threads") this.io.write((this.project?.threads.threads ?? []).map((t) => `${t.threadId} ${t.status}`).join("\n") || "No known threads.");
    else if (command === "/reindex") { this.project = this.projects.open(this.state.cwd, true); this.io.write("Project context reindexed."); }
    else if (command === "/model") await this.setModel(arg);
    else if (command === "/reasoning") this.setReasoning(arg);
    else if (command === "/profile") this.setProfile(arg);
    else if (command === "/agents") this.setAgent(arg);
    else if (command === "/skills") this.showCapabilities("skills");
    else if (command === "/plugins") this.showCapabilities("plugins");
    else if (command === "/mcp") this.showCapabilities("mcpServers");
    else if (command === "/tools") this.showCapabilities("tools");
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
    const agent = getCxAgent(this.state.agent);
    const selectedModel = strongerModel(this.state.model ?? initial.selectedModel, agent?.minimumModel);
    const selectedReasoning = this.state.reasoning ?? initial.reasoning;
    const usage = await this.usage();
    const routingDecision = { ...initial, selectedModel, reasoning: selectedReasoning };
    const minimumModel = strongerModel(this.state.model ?? "luna", agent?.minimumModel);
    const budget = new BudgetController().evaluate({ usage, routingDecision, ...(minimumModel !== "luna" ? { minimumModel } : {}), ...(this.state.profile !== "auto" ? { budgetStateCap: PROFILE_STATE[this.state.profile] } : {}) });
    this.lastBudgetState = budget.state;
    this.io.write(`${this.state.model || this.state.reasoning ? "OVERRIDE" : "AUTO"} → ${budget.preferredModel} ${selectedReasoning}\nBudget: ${budget.state}`);
    try {
      this.project ??= this.projects.open(this.state.cwd);
      const agentContext = agent?.context ? `[CX agent: ${agent.name}] ${agent.context}\n` : "";
      const result = await this.adapter.executeAuto({ prompt: `${agentContext}${this.projects.prompt(this.projects.envelope(this.project), prompt)}`, routingDecision, usageSnapshot: usage, ...(attachments.length ? { attachments } : {}), ...(this.state.threadId ? { threadId: this.state.threadId } : {}), ...(minimumModel !== "luna" ? { minimumModel } : {}), ...(this.state.reasoning ? { minimumReasoning: this.state.reasoning } : {}), ...(this.state.profile !== "auto" ? { budgetStateCap: PROFILE_STATE[this.state.profile] } : {}), dryRun: this.state.dryRun }, this.state.escalationEnabled ? {} : { policy: new NoEscalation() });
      this.state.attachments = [];
      this.state.messageCount++;
      const nextThread = result.finalResult?.threadId ?? result.taskExecution.threadId ?? this.state.threadId;
      if (nextThread) this.state.threadId = nextThread;
      if (this.project && nextThread) { if (!this.project.threads.threads.some((t) => t.threadId === nextThread)) this.project.threads.threads.push({ threadId: nextThread, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: "active" }); this.project.threads.activeThreadId = nextThread; this.projects.saveThreads(this.project.metadata.rootPath, this.project.threads); }
      for (const escalation of result.escalations) if (escalation.action === "escalate-model" && escalation.nextModel) this.io.write(`↑ Escalation → ${escalation.nextModel} ${escalation.nextReasoning ?? ""}`.trim());
      if (result.totalAttempts > 1) this.io.write(`↻ Retry → ${result.finalModel ?? budget.preferredModel} ${result.finalReasoning ?? selectedReasoning}`);
      if (result.finalStatus === "success" || result.finalStatus === "dry-run") this.io.write("✓ Completed");
      else { if (result.finalStatus === "unavailable" && this.project) { delete this.state.threadId; delete this.project.threads.activeThreadId; this.projects.saveThreads(this.project.metadata.rootPath, this.project.threads); } this.io.write(`✗ ${result.finalStatus}\nReason: ${result.stoppedReason}`); }
    } catch (error) { this.io.write(`✗ Execution failed\nReason: ${error instanceof Error ? error.message : "Unknown error"}`); }
    return "continue";
  }

  private async setModel(value: string | undefined): Promise<void> {
    if (!value) {
      const capabilities = await this.getCapabilities();
      const lines = capabilities.models.map((model) => `${model.logicalName === this.state.model || (!this.state.model && model.logicalName === "terra") ? "●" : " "} ${model.displayName} ${model.available ? "" : "(unavailable)"}`.trimEnd());
      return this.io.write(`Model: ${this.state.model ?? "AUTO"}\nAUTO\n${lines.join("\n")}`);
    }
    if (value === "auto") { delete this.state.model; this.persistPreferences(); return this.io.write("Model: AUTO"); }
    if (!Object.hasOwn(MODEL_CONFIG, value)) return this.io.write("Invalid model.");
    this.state.model = value as ModelId; this.persistPreferences(); this.io.write(`Model: ${value}`);
  }
  private setReasoning(value: string | undefined): void {
    if (!value) return this.io.write(`Reasoning: ${this.state.reasoning ?? "AUTO"}`);
    if (value === "auto") { delete this.state.reasoning; this.persistPreferences(); return this.io.write("Reasoning: AUTO"); }
    if (!["low", "medium", "high", "xhigh", "max"].includes(value)) return this.io.write("Invalid reasoning level.");
    if (this.state.model && !isReasoningSupported(this.state.model, value as ReasoningLevel)) return this.io.write("Reasoning level is incompatible with the model.");
    this.state.reasoning = value as ReasoningLevel; this.persistPreferences(); this.io.write(`Reasoning: ${value}`);
  }
  private setProfile(value: string | undefined): void {
    if (!value) return this.io.write(`Profile: ${this.state.profile}`);
    if (!["auto", "balanced", "conservative", "eco", "emergency"].includes(value)) return this.io.write("Invalid profile.");
    this.state.profile = value as CliProfile; this.persistPreferences(); this.io.write(`Profile: ${value}`);
  }
  private setBoolean(key: "dryRun" | "escalationEnabled", value: string | undefined): void {
    if (!value) return this.io.write(`${key === "dryRun" ? "Dry-run" : "Escalation"}: ${this.state[key] ? "on" : "off"}`);
    if (value !== "on" && value !== "off") return this.io.write("Use on or off.");
    this.state[key] = value === "on"; this.io.write(`${key === "dryRun" ? "Dry-run" : "Escalation"}: ${value}`);
  }
  private addImage(path: string | undefined): void { try { if (!path) throw new AttachmentError("Provide an image path."); this.state.attachments.push(...validateAttachments([{ type: "image", path } as CxAttachment], this.state.cwd)); this.io.write(`Image attached: ${this.state.attachments.at(-1)?.name}`); } catch (error) { this.io.write(`✗ ${error instanceof Error ? error.message : "Invalid image."}`); } }
  private setAgent(value: string | undefined): void {
    if (!value) return this.io.write(`CX AGENTS\n\n${CX_AGENTS.map((agent) => `${agent.id === this.state.agent ? "●" : " "} ${agent.name}${agent.minimumModel ? ` · minimum ${agent.minimumModel}` : ""}\n   ${agent.description}`).join("\n")}`);
    const agent = getCxAgent(value);
    if (!agent) return this.io.write("Invalid CX agent.");
    this.state.agent = agent.id; this.persistPreferences(); this.io.write(`Agent: ${agent.name}`);
  }
  private async getCapabilities(): Promise<CodexCapabilitySnapshot> {
    if (this.capabilities) return this.capabilities;
    try {
      this.capabilities = this.adapter.discoverCapabilities
        ? await this.adapter.discoverCapabilities(this.state.cwd)
        : await new CodexCapabilityRegistry({ discoverModels: async () => [] }).discover(this.state.cwd);
    } catch {
      this.capabilities = await new CodexCapabilityRegistry({ discoverModels: async () => [] }).discover(this.state.cwd);
    }
    return this.capabilities;
  }
  private async showCapabilities(key: "skills" | "plugins" | "mcpServers" | "tools"): Promise<void> {
    const title = { skills: "SKILLS", plugins: "PLUGINS", mcpServers: "MCP SERVERS", tools: "TOOLS" }[key];
    const values = (await this.getCapabilities())[key];
    if (!values.length) return this.io.write(`${title}\n\nNo ${title.toLowerCase()} discovered.`);
    if (key === "tools") {
      const groups = new Map<string, typeof values>();
      for (const value of values) groups.set(value.origin, [...(groups.get(value.origin) ?? []), value]);
      return this.io.write(`${title}\n\n${[...groups.entries()].map(([origin, entries]) => `${origin.toUpperCase()}\n${entries.slice(0, 15).map((value) => `  ${value.name} · ${value.status}`).join("\n")}${entries.length > 15 ? `\n  … ${entries.length - 15} more` : ""}`).join("\n\n")}`);
    }
    const visible = values.slice(0, 40);
    this.io.write(`${title}\n\n${visible.map((value) => `${value.name} · ${value.origin} · ${value.status}${value.toolCount !== undefined ? ` · ${value.toolCount} tools` : ""}${value.description ? `\n  ${value.description}` : ""}`).join("\n")}${values.length > visible.length ? `\n… ${values.length - visible.length} more` : ""}`);
  }
  private restorePreferences(): void {
    const preferences = this.project?.state.preferences;
    if (!preferences) return;
    if (this.state.profile === "auto" && ["auto", "balanced", "conservative", "eco", "emergency"].includes(preferences.profile ?? "")) this.state.profile = preferences.profile as CliProfile;
    if (!this.state.model && Object.hasOwn(MODEL_CONFIG, preferences.model ?? "")) this.state.model = preferences.model as ModelId;
    if (!this.state.reasoning && ["none", "low", "medium", "high", "xhigh", "max"].includes(preferences.reasoning ?? "")) this.state.reasoning = preferences.reasoning as ReasoningLevel;
    if (this.state.agent === "auto" && getCxAgent(preferences.activeAgent)) this.state.agent = preferences.activeAgent as CxAgentId;
  }
  private persistPreferences(): void {
    if (!this.project) return;
    this.project.state.preferences = { activeAgent: this.state.agent, profile: this.state.profile, ...(this.state.model ? { model: this.state.model } : {}), ...(this.state.reasoning ? { reasoning: this.state.reasoning } : {}) };
    this.projects.saveState(this.project.metadata.rootPath, this.project.state);
  }
  private async usage(): Promise<UsageSnapshot> { try { const usage = await this.adapter.getUsage(); this.lastUsage = usage; return usage; } catch { const usage = { source: "unknown" as const, capturedAt: new Date().toISOString() }; this.lastUsage = usage; return usage; } }
  private budgetState(usage: UsageSnapshot): BudgetState { const state = new BudgetController().evaluate({ usage, routingDecision: routeTask({ prompt: "status" }), ...(this.state.profile !== "auto" ? { budgetStateCap: PROFILE_STATE[this.state.profile] } : {}) }).state; this.lastBudgetState = state; return state; }
}
