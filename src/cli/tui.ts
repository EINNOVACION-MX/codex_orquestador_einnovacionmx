import { createRequire } from "node:module";
import type * as Blessed from "blessed";
import type { CodexExecutionEvent } from "../codex/types.ts";
import type { CliAdapter, CliProfile } from "./types.ts";
import { InteractiveSession, type InteractivePresentation } from "./interactive-session.ts";
import { CommandPalette } from "./command-palette.ts";
import { CX_COMMANDS } from "../capabilities/codex-capability-registry.ts";

const blessed = createRequire(import.meta.url)("blessed") as typeof Blessed;
export type ChatEntry = { role: "user" | "assistant" | "system" | "success" | "warning" | "error"; text: string; streaming?: boolean };
export interface TuiViewModel { header: string; status: string; detailStatus: string; history: string; }

const color = (role: ChatEntry["role"]) => ({ user: "cyan", assistant: "green", system: "white", success: "green", warning: "yellow", error: "red" }[role]);
const modelColor = (model: string) => ({ luna: "cyan", terra: "green", sol: "yellow", astra: "magenta" }[model.toLowerCase()] ?? "white");
const budgetColor = (budget: string) => ({ balanced: "green", conservative: "yellow", eco: "cyan", emergency: "red", unknown: "gray" }[budget.toLowerCase()] ?? "white");

export function supportsTerminalTui(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(input.isTTY && output.isTTY && process.env.TERM !== "dumb");
}

/** Testable, terminal-independent scroll and follow state. */
export class TranscriptViewport {
  public follow = true; public hasNewOutput = false; public scroll = 0;
  private contentHeight = 0; private viewportHeight = 1;
  public setGeometry(contentHeight: number, viewportHeight: number): void { this.contentHeight = Math.max(0, contentHeight); this.viewportHeight = Math.max(1, viewportHeight); this.scroll = this.follow ? this.maximumScroll() : Math.min(this.scroll, this.maximumScroll()); }
  public append(): void { if (this.follow) this.scroll = this.maximumScroll(); else this.hasNewOutput = true; }
  public move(lines: number): void { this.scroll = Math.max(0, Math.min(this.maximumScroll(), this.scroll + lines)); this.follow = this.scroll >= this.maximumScroll(); if (this.follow) this.hasNewOutput = false; }
  public home(): void { this.scroll = 0; this.follow = false; }
  public end(): void { this.scroll = this.maximumScroll(); this.follow = true; this.hasNewOutput = false; }
  public resize(viewportHeight: number): void { this.setGeometry(this.contentHeight, viewportHeight); }
  public maximumScroll(): number { return Math.max(0, this.contentHeight - this.viewportHeight); }
}

export function classifyChatEntry(text: string): ChatEntry["role"] {
  if (/^(?:✓|Completed)/.test(text)) return "success";
  if (/^(?:✗|Failed|Reason:)/.test(text)) return "error";
  if (/^(?:↻|↑|⚠|◌|Budget:|AUTO →|OVERRIDE →)/.test(text)) return "warning";
  return "assistant";
}

/** Appends progressive agent output without creating one chat block per delta. */
export function appendTranscriptEvent(entries: ChatEntry[], event: CodexExecutionEvent): void {
  if (event.type === "notice") { entries.push({ role: "warning", text: `⚠ ${event.message}` }); return; }
  const current = entries.at(-1);
  if (event.type === "agent-message-completed") {
    if (current?.streaming && current.role === "assistant") { current.text = event.message; current.streaming = false; }
    else entries.push({ role: "assistant", text: event.message });
    return;
  }
  if (current?.streaming && current.role === "assistant") current.text += event.delta;
  else entries.push({ role: "assistant", text: event.delta, streaming: true });
}

function escapeTags(text: string): string { return text.replaceAll("{", "\\{").replaceAll("}", "\\}"); }
/** Compact Markdown rendering. Blessed wraps the resulting transcript at the current terminal width. */
export function renderTranscriptMarkdown(value: string): string {
  return escapeTags(value).split("\n").map((line) => {
    if (/^#{1,3}\s+/.test(line)) return `{bold}${line.replace(/^#{1,3}\s+/, "")}{/bold}`;
    line = line.replace(/^\s*[-*]\s+/, "• ").replace(/^\s*(\d+)\.\s+/, "$1. ");
    return line.replace(/`([^`]+)`/g, "{cyan-fg}$1{/cyan-fg}");
  }).join("\n");
}

function compactStatus(p: InteractivePresentation, narrow = false): string {
  const model = p.model?.toUpperCase() ?? "AUTO";
  if (narrow) return `${p.projectName} │ ${model} │ ${p.budgetState.toUpperCase()} │ 5h ${p.fiveHourRemaining ?? "?"}%`;
  return `${p.projectName} │ ${model} ${p.reasoning?.toUpperCase() ?? "AUTO"} │ ${p.budgetState.toUpperCase()} │ 5h ${p.fiveHourRemaining ?? "?"}% │ W ${p.weeklyRemaining ?? "?"}% │ Agent ${p.agent}`;
}

export function buildTuiViewModel(p: InteractivePresentation, entries: readonly ChatEntry[]): TuiViewModel {
  const model = p.model?.toUpperCase() ?? "AUTO";
  return {
    header: `{bold}CX Auto Model Orchestrator{/bold}  {gray-fg}for OpenAI Codex · EINNOVACION MX · v${p.version}{/gray-fg}`,
    status: compactStatus(p),
    detailStatus: [`{bold}PROJECT{/bold}  ${p.projectName}`, `{bold}MODEL{/bold}    {${modelColor(p.model ?? "auto")}-fg}${model}{/${modelColor(p.model ?? "auto")}-fg} ${p.reasoning?.toUpperCase() ?? "AUTO"}`, `{bold}BUDGET{/bold}   {${budgetColor(p.budgetState)}-fg}${p.budgetState.toUpperCase()}{/${budgetColor(p.budgetState)}-fg}`, `{bold}USAGE{/bold}    5h ${p.fiveHourRemaining ?? "?"}% · Weekly ${p.weeklyRemaining ?? "?"}%`, `{bold}PROFILE{/bold}  ${p.profile.toUpperCase()}`, `{bold}AGENT{/bold}    ${p.agent}`, `{bold}THREAD{/bold}   ${p.threadId ?? "New"}`, `{bold}IMAGES{/bold}   ${p.pendingImages.length ? p.pendingImages.join(", ") : "None"}`].join("\n"),
    history: entries.length ? entries.map((entry) => {
      const label = entry.role === "user" ? "You" : "CX";
      return `{${color(entry.role)}-fg}{bold}${label}{/bold}{/${color(entry.role)}-fg}\n${entry.role === "user" ? "> " : ""}${renderTranscriptMarkdown(entry.text)}${entry.streaming ? "{gray-fg}▍{/gray-fg}" : ""}`;
    }).join("\n\n") : "{gray-fg}Ready for your next task.{/gray-fg}",
  };
}

/** Transcript-first terminal shell. It only presents InteractiveSession output. */
export class TerminalTui {
  private readonly entries: ChatEntry[] = []; private readonly viewport = new TranscriptViewport();
  private readonly screen: Blessed.Widgets.Screen; private readonly header: Blessed.Widgets.BoxElement; private readonly status: Blessed.Widgets.BoxElement; private readonly history: Blessed.Widgets.BoxElement; private readonly input: Blessed.Widgets.TextboxElement; private readonly palette: Blessed.Widgets.ListElement; private readonly details: Blessed.Widgets.BoxElement;
  private readonly commandPalette = new CommandPalette(CX_COMMANDS); private readonly session: InteractiveSession;
  private detailsVisible = false; private closed = false;

  public constructor(adapter: CliAdapter, cwd: string, initial: { profile: CliProfile; dryRun: boolean }) {
    this.screen = blessed.screen({ smartCSR: true, title: "CX Auto Model Orchestrator", fullUnicode: true });
    this.header = blessed.box({ parent: this.screen, top: 0, left: 1, right: 1, height: 1, tags: true, style: { fg: "white", bg: "black" } });
    this.status = blessed.box({ parent: this.screen, top: 1, left: 0, width: "100%", height: 1, tags: true, padding: { left: 1, right: 1 }, style: { fg: "white", bg: "blue" } });
    this.history = blessed.box({ parent: this.screen, top: 2, left: 1, right: 1, bottom: 3, tags: true, scrollable: true, mouse: true, keys: true, wrap: true, scrollbar: { ch: "│", track: { bg: "black" }, style: { fg: "cyan" } }, padding: { left: 1, right: 2 } });
    this.input = blessed.textbox({ parent: this.screen, bottom: 0, left: 0, width: "100%", height: 3, inputOnFocus: true, border: "line", label: " > ", padding: { left: 1 }, style: { border: { fg: "green" }, focus: { border: { fg: "cyan" } } } });
    this.palette = blessed.list({ parent: this.screen, bottom: 3, left: 2, width: "70%", height: "45%", hidden: true, tags: true, border: "line", label: " Commands ", mouse: true, style: { border: { fg: "cyan" }, selected: { bg: "cyan", fg: "black" } }, padding: { left: 1, right: 1 } });
    this.details = blessed.box({ parent: this.screen, top: 2, right: 1, width: 32, bottom: 3, hidden: true, tags: true, border: "line", label: " Status · F2 ", padding: { left: 1, top: 1, right: 1 }, style: { border: { fg: "cyan" }, bg: "black" } });
    this.session = new InteractiveSession(adapter, { write: (text) => this.write(text), stream: (event) => this.stream(event), clear: () => { this.entries.length = 0; this.viewport.end(); this.render(); } }, cwd, initial);
    this.input.on("submit", (value: string) => { void this.submit(value); }); this.input.on("keypress", (_: string, key: { name?: string }) => this.handleKey(key)); this.palette.on("select", (_: Blessed.Widgets.BoxElement, index: number) => this.acceptPalette(index));
    this.history.on("wheeldown", () => this.scroll(3)); this.history.on("wheelup", () => this.scroll(-3));
    this.screen.key(["C-c"], () => this.close()); this.screen.key(["escape"], () => this.commandPalette.snapshot().open ? this.hidePalette() : this.input.focus()); this.screen.key(["pageup"], () => this.scroll(-10)); this.screen.key(["pagedown"], () => this.scroll(10)); this.screen.key(["home"], () => { this.viewport.home(); this.render(); }); this.screen.key(["end"], () => { this.viewport.end(); this.render(); }); this.screen.key(["C-up"], () => this.scroll(-3)); this.screen.key(["C-down"], () => this.scroll(3));
    this.screen.key(["f2"], () => { this.detailsVisible = !this.detailsVisible; this.details[this.detailsVisible ? "show" : "hide"](); this.render(); }); this.screen.on("resize", () => this.render());
  }
  public async run(): Promise<void> { await this.session.start(false); this.render(); this.input.focus(); this.screen.render(); await new Promise<void>((resolve) => this.screen.once("destroy", () => resolve())); }
  public viewModel(): TuiViewModel { return buildTuiViewModel(this.session.presentation(), this.entries); }
  public transcript(): readonly ChatEntry[] { return this.entries; }
  private write(text: string): void { const current = this.entries.at(-1); if (current?.role === "assistant" && current.text === text) { current.streaming = false; } else if (current?.streaming && current.role === "assistant" && !/^(?:◌|AUTO →|OVERRIDE →)/.test(text)) { current.text = text; current.streaming = false; } else this.entries.push({ role: classifyChatEntry(text), text }); this.viewport.append(); this.render(); }
  private stream(event: CodexExecutionEvent): void { appendTranscriptEvent(this.entries, event); this.viewport.append(); this.render(); }
  private render(): void { const model = this.viewModel(); const narrow = (this.screen.width as number) < 72; this.header.setContent(model.header); this.status.setContent(`${narrow ? compactStatus(this.session.presentation(), true) : model.status}${this.viewport.hasNewOutput ? "  {yellow-fg}↓ New output{/yellow-fg}" : ""}`); this.details.setContent(model.detailStatus); this.history.setContent(model.history); const element = this.history as unknown as { getScrollHeight?: () => number; setScroll: (offset: number) => void; height: number }; this.viewport.setGeometry(element.getScrollHeight?.() ?? model.history.split("\n").length, Math.max(1, (this.history.height as number) - 1)); element.setScroll(this.viewport.follow ? this.viewport.maximumScroll() : this.viewport.scroll); this.screen.render(); }
  private scroll(lines: number): void { this.viewport.move(lines); this.render(); }
  private async submit(raw: string): Promise<void> { let value = raw.trim(); if (this.commandPalette.snapshot().open) value = this.commandPalette.accept() ?? value; this.hidePalette(); this.input.clearValue(); this.input.focus(); if (!value) return this.render(); this.entries.push({ role: "user", text: value }); if (!value.startsWith("/")) this.entries.push({ role: "warning", text: "◌ Analizando tarea..." }); this.viewport.append(); this.render(); if (await this.session.handle(value) === "exit") this.close(); }
  private handleKey(key: { name?: string }): void { const current = this.input.getValue(); if (key.name === "escape") return; if (key.name === "up" && this.commandPalette.snapshot().open) { this.commandPalette.move(-1); return this.renderPalette(); } if (key.name === "down" && this.commandPalette.snapshot().open) { this.commandPalette.move(1); return this.renderPalette(); } if (key.name === "tab") { const completed = this.commandPalette.complete(current); if (completed) { this.input.setValue(completed); this.refreshPalette(completed); } return; } setImmediate(() => this.refreshPalette(this.input.getValue())); }
  private refreshPalette(value: string): void { if (value.startsWith("/")) { this.commandPalette.update(value); this.renderPalette(); } else this.hidePalette(); }
  private renderPalette(): void { const state = this.commandPalette.snapshot(); if (!state.open || !state.items.length) { this.palette.hide(); this.screen.render(); return; } this.palette.setItems(state.items.map((item) => `{bold}${item.command}{/bold}  {gray-fg}${item.description}{/gray-fg}`)); this.palette.select(state.selected); this.palette.show(); this.screen.render(); }
  private acceptPalette(index?: number): void { if (index !== undefined) { const delta = index - this.commandPalette.snapshot().selected; if (delta) this.commandPalette.move(delta); } const selected = this.commandPalette.accept(); if (!selected) return; this.input.setValue(selected); this.hidePalette(); this.input.focus(); this.screen.render(); }
  private hidePalette(): void { this.commandPalette.close(); this.palette.hide(); this.screen.render(); }
  private close(): void { if (!this.closed) { this.closed = true; this.screen.destroy(); } }
}
