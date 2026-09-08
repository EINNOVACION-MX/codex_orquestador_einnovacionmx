import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendTranscriptEvent, buildTuiViewModel, classifyChatEntry, renderTranscriptMarkdown, supportsTerminalTui, TranscriptViewport, type ChatEntry } from "../src/cli/tui.ts";
import type { InteractivePresentation } from "../src/cli/interactive-session.ts";

const presentation: InteractivePresentation = {
  projectName: "Orquestador_Codex", profile: "conservative", budgetState: "conservative", fiveHourRemaining: 73,
  weeklyRemaining: 56, pendingImages: ["login.png"], version: "0.3.0", agent: "AUTO",
};

describe("Terminal TUI", () => {
  it("renders startup identity and persistent status data", () => {
    const output = buildTuiViewModel(presentation, []);
    assert.match(output.header, /CX Auto Model Orchestrator/); assert.match(output.header, /EINNOVACION MX/);
    assert.match(output.status, /Orquestador_Codex/); assert.match(output.status, /73%/); assert.match(output.status, /Agent AUTO/); assert.match(output.detailStatus, /login.png/);
  });
  it("keeps chat history renderable with retry, escalation, and errors", () => {
    const history: ChatEntry[] = [
      { role: "user", text: "Analiza pagos" }, { role: "warning", text: "↻ Retry → Terra Medium" },
      { role: "warning", text: "↑ Escalation → Sol High" }, { role: "error", text: "✗ Failed" },
    ];
    const output = buildTuiViewModel(presentation, history);
    assert.match(output.history, /You/); assert.match(output.history, /Retry/); assert.match(output.history, /Escalation/); assert.match(output.history, /Failed/);
  });
  it("keeps a long transcript scrollable and follows only while already at the end", () => {
    const viewport = new TranscriptViewport(); viewport.setGeometry(100, 10); assert.equal(viewport.scroll, 90);
    viewport.move(-20); assert.equal(viewport.follow, false); viewport.append(); assert.equal(viewport.hasNewOutput, true); assert.equal(viewport.scroll, 70);
    viewport.move(100); assert.equal(viewport.follow, true); assert.equal(viewport.hasNewOutput, false); viewport.resize(20); assert.equal(viewport.scroll, 80);
    viewport.home(); assert.equal(viewport.scroll, 0); viewport.end(); assert.equal(viewport.scroll, 80);
  });
  it("updates a single CX transcript entry while output streams", () => {
    const entries: ChatEntry[] = [{ role: "user", text: "Analiza el flujo" }];
    appendTranscriptEvent(entries, { type: "agent-message-delta", delta: "Estoy revisando" }); appendTranscriptEvent(entries, { type: "agent-message-delta", delta: " el flujo..." });
    assert.equal(entries.length, 2); assert.equal(entries[1]?.text, "Estoy revisando el flujo..."); assert.equal(entries[1]?.streaming, true);
    appendTranscriptEvent(entries, { type: "agent-message-completed", message: "Estoy revisando el flujo completo." }); assert.equal(entries[1]?.text, "Estoy revisando el flujo completo."); assert.equal(entries[1]?.streaming, false);
  });
  it("renders Markdown without horizontal transcript formatting", () => {
    const rendered = renderTranscriptMarkdown("# Resultado\n- uno\n1. dos\nusa `cx status`");
    assert.match(rendered, /Resultado/); assert.match(rendered, /• uno/); assert.match(rendered, /1\. dos/); assert.match(rendered, /cyan-fg/);
  });
  it("classifies visible execution states and keeps a non-TTY fallback", () => {
    assert.equal(classifyChatEntry("✓ Completed"), "success"); assert.equal(classifyChatEntry("↻ Retry → Terra"), "warning"); assert.equal(classifyChatEntry("↑ Escalation → Sol"), "warning"); assert.equal(classifyChatEntry("✗ Failed"), "error"); assert.equal(classifyChatEntry("◌ Reading README.md"), "warning");
    assert.equal(supportsTerminalTui({ isTTY: false } as NodeJS.ReadStream, { isTTY: false } as NodeJS.WriteStream), false);
  });
});
