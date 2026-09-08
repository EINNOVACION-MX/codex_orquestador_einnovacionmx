import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTuiViewModel, classifyChatEntry, supportsTerminalTui, type ChatEntry } from "../src/cli/tui.ts";
import type { InteractivePresentation } from "../src/cli/interactive-session.ts";

const presentation: InteractivePresentation = {
  projectName: "Orquestador_Codex", profile: "conservative", budgetState: "conservative", fiveHourRemaining: 73,
  weeklyRemaining: 56, pendingImages: ["login.png"], version: "0.2.0", agent: "AUTO",
};

describe("Terminal TUI", () => {
  it("renders startup identity and persistent status data", () => {
    const output = buildTuiViewModel(presentation, []);
    assert.match(output.header, /CX Auto Model Orchestrator/); assert.match(output.header, /EINNOVACION MX/);
    assert.match(output.status, /Orquestador_Codex/); assert.match(output.status, /73%/); assert.match(output.status, /login.png/);
  });
  it("keeps chat history renderable with retry, escalation, and errors", () => {
    const history: ChatEntry[] = [
      { role: "user", text: "Analiza pagos" }, { role: "warning", text: "↻ Retry → Terra Medium" },
      { role: "warning", text: "↑ Escalation → Sol High" }, { role: "error", text: "✗ Failed" },
    ];
    const output = buildTuiViewModel(presentation, history);
    assert.match(output.history, /You/); assert.match(output.history, /Retry/); assert.match(output.history, /Escalation/); assert.match(output.history, /Failed/);
  });
  it("classifies visible execution states and keeps a non-TTY fallback", () => {
    assert.equal(classifyChatEntry("✓ Completed"), "success"); assert.equal(classifyChatEntry("↻ Retry → Terra"), "warning"); assert.equal(classifyChatEntry("↑ Escalation → Sol"), "warning"); assert.equal(classifyChatEntry("✗ Failed"), "error");
    assert.equal(supportsTerminalTui({ isTTY: false } as NodeJS.ReadStream, { isTTY: false } as NodeJS.WriteStream), false);
  });
});
