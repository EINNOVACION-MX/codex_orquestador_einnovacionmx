import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectContextService } from "../src/project/project-context-service.ts";
import { InteractiveSession } from "../src/cli/interactive-session.ts";
import { parseCliArgs } from "../src/cli/parse.ts";
import type { CliAdapter } from "../src/cli/types.ts";
import type { OrchestrationRequest, OrchestrationResult } from "../src/orchestration/types.ts";
import type { UsageSnapshot } from "../src/budget/types.ts";

const usage: UsageSnapshot = { source: "manual", capturedAt: "2026-09-06T12:00:00.000Z", fiveHour: { remainingPercent: 73 }, weekly: { remainingPercent: 56 } };
class Adapter implements CliAdapter {
  public calls: OrchestrationRequest[] = []; public fail = false; public unavailable = false;
  public agentMessage: string | undefined; public notices: string[] | undefined;
  public interrupts = 0;
  public async getUsage(): Promise<UsageSnapshot> { if (this.fail) throw new Error("App Server unavailable"); return usage; }
  public async executeAuto(input: OrchestrationRequest): Promise<OrchestrationResult> {
    this.calls.push(input); if (this.fail) throw new Error("execution failed");
    const routing = input.routingDecision!; const threadId = input.threadId ?? "thread-1";
    const finalStatus = this.unavailable ? "unavailable" : "success";
    const finalResult = this.agentMessage || this.notices ? { requestedModel: routing.selectedModel, resolvedModel: routing.selectedModel, reasoning: routing.reasoning, threadId, status: "completed" as const, fallbackUsed: false, durationMs: 1, ...(this.agentMessage ? { agentMessage: this.agentMessage } : {}), ...(this.notices ? { notices: this.notices } : {}) } : undefined;
    return { taskExecution: { id: "x", prompt: input.prompt, routingDecision: routing, threadId, createdAt: usage.capturedAt, updatedAt: usage.capturedAt, attempts: [], finalStatus: this.unavailable ? "not-executed" : "success" }, finalStatus, finalModel: routing.selectedModel, finalReasoning: routing.reasoning, totalAttempts: 1, escalations: [], budgetDecisions: [], stoppedReason: "done", usageSnapshot: usage, budgetState: "conservative", executionBudget: { state: "conservative", reasoningCaps: {}, maxAttemptsPerModel: { luna: 2, terra: 2, sol: 1, astra: 1 }, maxTotalAttempts: 4, allowAutomaticEscalationToSol: true, allowAutomaticEscalationToAstra: false, reasons: [] }, ...(finalResult ? { finalResult } : {}), ...(this.agentMessage ? { agentMessage: this.agentMessage } : {}), ...(this.notices ? { notices: this.notices } : {}) };
  }
  public async close(): Promise<void> {}
  public async interruptActiveTurn(): Promise<boolean> { this.interrupts++; return true; }
}
function session(adapter = new Adapter()) { const output: string[] = []; const cwd = mkdtempSync(join(tmpdir(), "cx-interactive-")); return { adapter, output, cwd, value: new InteractiveSession(adapter, { write: (text) => output.push(text), clear: () => output.push("clear") }, cwd) }; }

describe("InteractiveSession", () => {
  it("is selected by cx with no arguments while prompts remain one-shot", () => {
    assert.equal(parseCliArgs([]).command, "interactive");
    assert.equal(parseCliArgs(["cambia padding"]).command, "run");
  });
  it("creates a thread on the first message and reuses it after rerouting", async () => {
    const s = session(); await s.value.handle("Cambia el padding"); await s.value.handle("Implementa autenticación");
    assert.equal(s.adapter.calls[0]?.threadId, undefined);
    assert.equal(s.adapter.calls[1]?.threadId, "thread-1");
    assert.equal(s.adapter.calls[0]?.routingDecision?.selectedModel, "luna");
    assert.equal(s.adapter.calls[1]?.routingDecision?.selectedModel, "terra");
  });
  it("handles status and overrides without starting a task", async () => {
    const s = session(); await s.value.handle("/status"); await s.value.handle("/model terra"); await s.value.handle("/reasoning high"); await s.value.handle("/profile eco"); await s.value.handle("/dry-run on"); await s.value.handle("/escalation off");
    assert.equal(s.adapter.calls.length, 0); assert.equal(s.value.state.model, "terra"); assert.equal(s.value.state.reasoning, "high"); assert.equal(s.value.state.profile, "eco"); assert.equal(s.value.state.dryRun, true); assert.equal(s.value.state.escalationEnabled, false);
  });
  it("shows compact startup identity and independent-project about text", async () => {
    const s = session(); await s.value.start(); await s.value.handle("/about");
    const output = s.output.join("\n");
    assert.match(output, /CX Auto Model Orchestrator/); assert.match(output, /Developed by EINNOVACION MX/); assert.match(output, /Project:/); assert.match(output, /not an official OpenAI product/);
    assert.equal(s.adapter.calls.length, 0);
  });
  it("renders the structured command help without starting a task", async () => {
    const s = session(); await s.value.handle("/help");
    assert.match(s.output.join("\n"), /COMMANDS/); assert.match(s.output.join("\n"), /\/image/); assert.match(s.output.join("\n"), /\/interrupt/); assert.equal(s.adapter.calls.length, 0);
  });
  it("removes overrides with auto and new removes only the thread", async () => {
    const s = session(); await s.value.handle("one"); await s.value.handle("/model terra"); await s.value.handle("/reasoning high"); await s.value.handle("/model auto"); await s.value.handle("/reasoning auto"); await s.value.handle("/clear"); await s.value.handle("/new");
    assert.equal(s.value.state.threadId, undefined); assert.equal(s.value.state.model, undefined); assert.equal(s.value.state.reasoning, undefined); assert.ok(s.output.includes("clear"));
  });
  it("restores a stored thread and clears it after controlled invalid-thread recovery", async () => {
    const s = session(); const projects = new ProjectContextService(); const project = projects.open(s.cwd); project.threads.activeThreadId = "missing-thread"; project.threads.threads.push({ threadId: "missing-thread", createdAt: "now", lastUsedAt: "now", status: "active" }); projects.saveThreads(s.cwd, project.threads);
    s.adapter.unavailable = true; await s.value.start(); assert.equal(s.value.state.threadId, "missing-thread"); await s.value.handle("Cambia padding"); assert.equal(s.value.state.threadId, undefined); assert.equal(projects.open(s.cwd).threads.activeThreadId, undefined);
  });
  it("exits for /exit and exit and recovers from task or usage errors", async () => {
    const s = session(); assert.equal(await s.value.handle("/exit"), "exit"); assert.equal(await s.value.handle("exit"), "exit");
    const broken = session(); broken.adapter.fail = true; assert.equal(await broken.value.handle("Cambia padding"), "continue"); assert.match(broken.output.join("\n"), /Execution failed/);
  });
  it("uses the same safe interrupt path for /interrupt", async () => {
    const s = session(); await s.value.handle("/interrupt"); await s.value.handle("/interrupt");
    assert.equal(s.adapter.interrupts, 2); assert.match(s.output.join("\n"), /Turn interrupted/);
  });
  it("uses pending images for the next message and then clears them", async () => { const s = session(); writeFileSync(join(s.cwd, "login.png"), "png"); await s.value.handle("/image login.png"); await s.value.handle("/images"); assert.match(s.output.join("\n"), /login.png/); await s.value.handle("Cambia el login"); assert.equal(s.adapter.calls[0]?.attachments?.length, 1); assert.equal(s.value.state.attachments.length, 0); await s.value.handle("/images clear"); });
  it("persists CX agent preferences and applies Security as a Sol minimum", async () => {
    const s = session(); await s.value.start(); await s.value.handle("/agents security"); await s.value.handle("Revisa permisos RLS");
    assert.equal(s.value.state.agent, "security"); assert.equal(s.adapter.calls[0]?.routingDecision?.selectedModel, "sol"); assert.equal(s.adapter.calls[0]?.minimumModel, "sol");
    const again = new InteractiveSession(s.adapter, { write: () => undefined }, s.cwd); await again.start(); assert.equal(again.state.agent, "security");
  });
  it("renders the agent response before completion and warns when it is missing", async () => {
    const adapter = new Adapter(); adapter.agentMessage = "El proyecto enruta automáticamente las tareas."; adapter.notices = ["Codex needs your input before it can continue."];
    const s = session(adapter); await s.value.handle("Describe el proyecto");
    assert.ok(s.output.indexOf("El proyecto enruta automáticamente las tareas.") < s.output.indexOf("✓ Completed"));
    assert.match(s.output.join("\n"), /⚠ Codex needs your input/);
    const missing = session(); await missing.value.handle("Describe el proyecto");
    assert.match(missing.output.join("\n"), /Completed without a visible agent message/);
  });
});
