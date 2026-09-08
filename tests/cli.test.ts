import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliApplication } from "../src/cli/app.ts";
import { parseCliArgs } from "../src/cli/parse.ts";
import type { CliAdapter } from "../src/cli/types.ts";
import type { OrchestrationRequest, OrchestrationResult } from "../src/orchestration/types.ts";
import type { UsageSnapshot } from "../src/budget/types.ts";
import { routeTask } from "../src/router.ts";
import { formatHelp, formatVersion } from "../src/cli/identity.ts";

const usage: UsageSnapshot = { source: "manual", capturedAt: "2026-09-06T12:00:00.000Z", fiveHour: { remainingPercent: 92 }, weekly: { remainingPercent: 59 } };

function result(input: OrchestrationRequest): OrchestrationResult {
  const decision = input.routingDecision ?? routeTask({ prompt: input.prompt });
  return {
    taskExecution: { id: "task-1", prompt: input.prompt, routingDecision: decision, threadId: null, createdAt: usage.capturedAt, updatedAt: usage.capturedAt, attempts: [], finalStatus: input.dryRun ? "dry-run" : "success" },
    finalStatus: input.dryRun ? "dry-run" : "success", finalModel: decision.selectedModel, finalReasoning: decision.reasoning,
    totalAttempts: 0, escalations: [], budgetDecisions: [], stoppedReason: "done", usageSnapshot: usage, budgetState: "conservative",
    executionBudget: { state: "conservative", reasoningCaps: { luna: "medium", terra: "high", sol: "high" }, maxAttemptsPerModel: { luna: 2, terra: 2, sol: 1, astra: 1 }, maxTotalAttempts: 4, allowAutomaticEscalationToSol: true, allowAutomaticEscalationToAstra: false, reasons: [] },
  };
}

class FakeAdapter implements CliAdapter {
  public turns = 0;
  public readonly inputs: OrchestrationRequest[] = [];
  public policyProvided = false;
  private readonly suppliedUsage: UsageSnapshot;
  private readonly usageError: boolean;
  public constructor(suppliedUsage: UsageSnapshot = usage, usageError = false) {
    this.suppliedUsage = suppliedUsage;
    this.usageError = usageError;
  }
  public async getUsage(): Promise<UsageSnapshot> { if (this.usageError) throw new Error("Codex App Server unavailable"); return this.suppliedUsage; }
  public async executeAuto(input: OrchestrationRequest, options?: { policy?: import("../src/orchestration/types.ts").EscalationPolicyService }): Promise<OrchestrationResult> {
    this.turns++; this.inputs.push(input); this.policyProvided = Boolean(options?.policy); return result(input);
  }
  public async close(): Promise<void> {}
}

describe("CLI parsing", () => {
  it("parses the AUTO command and all supported flags", () => {
    assert.deepEqual(parseCliArgs(["Cambia el padding", "--dry-run", "--json", "--profile", "eco", "--model", "terra", "--reasoning", "medium", "--no-escalation"]), {
      command: "run", prompt: "Cambia el padding", dryRun: true, json: true, profile: "eco", model: "terra", reasoning: "medium", noEscalation: true,
    });
    assert.equal(parseCliArgs(["status"]).command, "status");
    assert.equal(parseCliArgs(["--version"]).command, "version");
    assert.equal(parseCliArgs(["--help"]).command, "help");
    assert.throws(() => parseCliArgs(["prompt", "--model", "invalid"]), /--model/);
  });

  it("formats version and help without adding branding to JSON task output", () => {
    assert.match(formatVersion(), /^CX Auto Model Orchestrator 0\.3\.0$/);
    assert.match(formatHelp(), /--image, -i <path>/);
    assert.match(execFileSync(process.execPath, ["--experimental-strip-types", "bin/cx.js", "--version"], { cwd: process.cwd(), encoding: "utf8" }), /^CX Auto Model Orchestrator 0\.3\.0/);
  });
});

describe("CLI application", () => {
  it("runs a normal prompt in AUTO and reports human output", async () => {
    const adapter = new FakeAdapter();
    const response = await new CliApplication(adapter).run(parseCliArgs(["Cambia el padding del navbar"]));
    assert.equal(response.exitCode, 0);
    assert.match(response.stdout, /AUTO MODEL/);
    assert.equal(adapter.inputs[0]?.routingDecision?.selectedModel, "luna");
    assert.match(adapter.inputs[0]?.prompt ?? "", /^\[CX project context: /);
  });

  it("uses dry-run without a real Codex turn", async () => {
    const adapter = new FakeAdapter();
    await new CliApplication(adapter).run(parseCliArgs(["Cambia el padding", "--dry-run"]));
    assert.equal(adapter.inputs[0]?.dryRun, true);
    assert.equal(adapter.turns, 1);
  });

  it("writes stable JSON with no human output", async () => {
    const response = await new CliApplication(new FakeAdapter()).run(parseCliArgs(["Cambia el padding", "--json"]));
    const json = JSON.parse(response.stdout) as { task: { domain: string }; usageSnapshot: UsageSnapshot; budgetState: string; orchestrationResult: OrchestrationResult };
    assert.equal(json.task.domain, "frontend");
    assert.equal(json.usageSnapshot.weekly?.remainingPercent, 59);
    assert.equal(json.budgetState, "conservative");
    assert.equal(response.stderr, "");
    assert.equal(response.stdout.includes("Developed by EINNOVACION MX"), false);
    assert.equal(json.orchestrationResult.finalStatus, "success");
    assert.equal(typeof json.orchestrationResult.finalResult, "undefined");
  });

  it("reads status without executing an orchestration", async () => {
    const adapter = new FakeAdapter();
    const response = await new CliApplication(adapter).run(parseCliArgs(["status"]));
    assert.match(response.stdout, /CODEX STATUS/);
    assert.match(response.stdout, /CONSERVATIVE/);
    assert.equal(adapter.turns, 0);
  });

  it("serves metadata commands without using the adapter", async () => {
    const adapter = new FakeAdapter();
    const version = await new CliApplication(adapter).run(parseCliArgs(["--version"]));
    const help = await new CliApplication(adapter).run(parseCliArgs(["--help"]));
    assert.match(version.stdout, /CX Auto Model Orchestrator/); assert.match(help.stdout, /Usage:/); assert.equal(adapter.turns, 0);
  });

  it("records profile and model overrides and validates incompatible reasoning", async () => {
    const adapter = new FakeAdapter();
    const response = await new CliApplication(adapter).run(parseCliArgs(["Cambia el padding", "--profile", "eco", "--model", "terra"]));
    assert.equal(adapter.inputs[0]?.budgetStateCap, "eco");
    assert.equal(adapter.inputs[0]?.minimumModel, "terra");
    assert.match(response.stdout, /Overrides: profile=eco, model=terra/);
    const invalid = await new CliApplication(new FakeAdapter()).run(parseCliArgs(["Cambia", "--model", "astra", "--reasoning", "none"]));
    assert.equal(invalid.exitCode, 2);
    assert.match(invalid.stderr, /does not support/);
  });

  it("disables model escalation while preserving retries and returns controlled errors", async () => {
    const adapter = new FakeAdapter();
    await new CliApplication(adapter).run(parseCliArgs(["Implementa clientes", "--no-escalation"]));
    assert.equal(adapter.policyProvided, true);
    const unavailable = await new CliApplication(new FakeAdapter(usage, true)).run(parseCliArgs(["status"]));
    assert.equal(unavailable.exitCode, 1);
    assert.match(unavailable.stderr, /unavailable/);
  });

  it("continues tasks with unknown usage when usage collection fails", async () => {
    const adapter = new FakeAdapter(usage, true);
    const response = await new CliApplication(adapter).run(parseCliArgs(["Cambia el padding"]));
    assert.equal(response.exitCode, 0);
    assert.equal(adapter.inputs[0]?.usageSnapshot?.source, "unknown");
  });

  it("passes repeatable image metadata through dry-run without exposing bytes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cx-cli-image-"));
    writeFileSync(join(cwd, "package.json"), "{}"); writeFileSync(join(cwd, "first.png"), "png"); writeFileSync(join(cwd, "second.jpg"), "jpg");
    const adapter = new FakeAdapter();
    const response = await new CliApplication(adapter, cwd).run(parseCliArgs(["Cambia el login", "-i", "first.png", "--image", "second.jpg", "--dry-run", "--json"]));
    const json = JSON.parse(response.stdout) as { attachments: Array<{ name: string; type: string }>; routingDecision: { hasVisualContext?: boolean } };
    assert.equal(adapter.inputs[0]?.dryRun, true);
    assert.equal(adapter.inputs[0]?.attachments?.length, 2);
    assert.equal(adapter.inputs[0]?.routingDecision?.hasVisualContext, true);
    assert.deepEqual(json.attachments.map((image) => image.name), ["first.png", "second.jpg"]);
    assert.deepEqual(Object.keys(json.attachments[0] ?? {}).sort(), ["name", "type"]);
  });
});
