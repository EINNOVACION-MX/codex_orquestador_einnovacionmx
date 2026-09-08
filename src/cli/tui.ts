import { createRequire } from "node:module";
import type * as Blessed from "blessed";
import type { CliAdapter, CliProfile } from "./types.ts";
import { InteractiveSession, type InteractivePresentation } from "./interactive-session.ts";
import { CommandPalette } from "./command-palette.ts";
import { CX_COMMANDS } from "../capabilities/codex-capability-registry.ts";

const blessed = createRequire(import.meta.url)("blessed") as typeof Blessed;

export type ChatEntry = { role: "user" | "system" | "success" | "warning" | "error"; text: string };
export interface TuiViewModel { header: string; status: string; history: string; }

const colorForModel = (model: string) => ({ luna: "cyan", terra: "green", sol: "yellow", astra: "magenta" }[model.toLowerCase()] ?? "white");
const colorForBudget = (budget: string) => ({ balanced: "green", conservative: "yellow", eco: "cyan", emergency: "red", unknown: "gray" }[budget.toLowerCase()] ?? "white");
const colorForRole = (role: ChatEntry["role"]) => ({ user: "cyan", system: "white", success: "green", warning: "yellow", error: "red" }[role]);

export function supportsTerminalTui(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(input.isTTY && output.isTTY && process.env.TERM !== "dumb");
}

export function classifyChatEntry(text: string): ChatEntry["role"] {
  if (/^(?:✓|Completed)/.test(text)) return "success";
  if (/^(?:✗|Failed|Reason:)/.test(text)) return "error";
  if (/^(?:↻|↑|Budget:|AUTO →|OVERRIDE →)/.test(text)) return "warning";
  return "system";
}

export function buildTuiViewModel(presentation: InteractivePresentation, entries: readonly ChatEntry[]): TuiViewModel {
  const model = presentation.model?.toUpperCase() ?? "AUTO";
  const modelColor = colorForModel(presentation.model ?? "auto");
  const budgetColor = colorForBudget(presentation.budgetState);
  return {
    header: `{bold}CX Auto Model Orchestrator{/bold}  {gray-fg}for OpenAI Codex{/gray-fg}\n{gray-fg}Developed by EINNOVACION MX · Open Source · v${presentation.version}{/gray-fg}`,
    status: [
      `{bold}PROJECT{/bold}  ${presentation.projectName}`,
      `{bold}MODEL{/bold}    {${modelColor}-fg}${model}{/${modelColor}-fg}`,
      `{bold}BUDGET{/bold}   {${budgetColor}-fg}${presentation.budgetState.toUpperCase()}{/${budgetColor}-fg}`,
      `{bold}USAGE{/bold}    5h ${presentation.fiveHourRemaining ?? "?"}%  |  Weekly ${presentation.weeklyRemaining ?? "?"}%`,
      `{bold}PROFILE{/bold}  ${presentation.profile.toUpperCase()}`,
      `{bold}AGENT{/bold}    ${presentation.agent}`,
      `{bold}REASONING{/bold} ${presentation.reasoning?.toUpperCase() ?? "AUTO"}`,
      `{bold}THREAD{/bold}   ${presentation.threadId ?? "New"}`,
      `{bold}IMAGES{/bold}   ${presentation.pendingImages.length ? presentation.pendingImages.join(", ") : "None"}`,
    ].join("\n"),
    history: entries.length ? entries.map((entry) => `{${colorForRole(entry.role)}-fg}${entry.role === "user" ? "You" : "CX"}{/${colorForRole(entry.role)}-fg}  ${entry.text}`).join("\n\n") : "{gray-fg}Ready for your next task.{/gray-fg}",
  };
}

/** Blessed-based terminal shell. It is presentation-only and delegates all behavior to InteractiveSession. */
export class TerminalTui {
  private readonly session: InteractiveSession;
  private readonly entries: ChatEntry[] = [];
  private readonly screen: Blessed.Widgets.Screen;
  private readonly header: Blessed.Widgets.BoxElement;
  private readonly status: Blessed.Widgets.BoxElement;
  private readonly history: Blessed.Widgets.Log;
  private readonly input: Blessed.Widgets.TextboxElement;
  private readonly palette: Blessed.Widgets.ListElement;
  private readonly commandPalette = new CommandPalette(CX_COMMANDS);
  private closed = false;

  public constructor(adapter: CliAdapter, cwd: string, initial: { profile: CliProfile; dryRun: boolean }) {
    this.screen = blessed.screen({ smartCSR: true, title: "CX Auto Model Orchestrator", fullUnicode: true });
    this.header = blessed.box({ parent: this.screen, top: 0, left: 0, width: "100%", height: 4, tags: true, padding: { left: 2, top: 1 }, style: { fg: "white", bg: "black" } });
    this.status = blessed.box({ parent: this.screen, top: 4, left: 0, width: 31, bottom: 3, tags: true, border: "line", label: " Status ", padding: { left: 1, right: 1, top: 1 }, style: { border: { fg: "cyan" } } });
    this.history = blessed.log({ parent: this.screen, top: 4, left: 31, right: 0, bottom: 3, tags: true, border: "line", label: " CX Conversation ", scrollable: true, alwaysScroll: true, mouse: true, keys: true, padding: { left: 1, right: 1 }, style: { border: { fg: "cyan" } } });
    this.input = blessed.textbox({ parent: this.screen, bottom: 0, left: 0, width: "100%", height: 3, inputOnFocus: true, border: "line", label: " CX Input ", padding: { left: 1 }, style: { border: { fg: "green" }, focus: { border: { fg: "cyan" } } } });
    this.palette = blessed.list({ parent: this.screen, top: 5, left: 33, width: "55%", height: "50%", hidden: true, tags: true, border: "line", label: " Commands ", keys: false, mouse: true, vi: false, style: { border: { fg: "cyan" }, selected: { bg: "cyan", fg: "black" }, item: { fg: "white" } }, padding: { left: 1, right: 1 } });
    this.session = new InteractiveSession(adapter, { write: (text) => this.write(text), clear: () => { this.entries.length = 0; this.render(); } }, cwd, initial);
    this.input.on("submit", (value: string) => { void this.submit(value); });
    this.input.on("keypress", (_character: string, key: { name?: string }) => this.handleKey(key));
    this.palette.on("select", (_item: Blessed.Widgets.BoxElement, index: number) => this.acceptPalette(index));
    this.screen.key(["C-c"], () => this.close());
    this.screen.key(["escape"], () => this.commandPalette.snapshot().open ? this.hidePalette() : this.close());
    this.screen.key(["pageup"], () => { this.history.scroll(-10); this.screen.render(); });
    this.screen.key(["pagedown"], () => { this.history.scroll(10); this.screen.render(); });
  }

  public async run(): Promise<void> {
    await this.session.start(false);
    this.render(); this.input.focus(); this.screen.render();
    await new Promise<void>((resolve) => this.screen.once("destroy", () => resolve()));
  }

  public viewModel(): TuiViewModel { return buildTuiViewModel(this.session.presentation(), this.entries); }

  private write(text: string): void { this.entries.push({ role: classifyChatEntry(text), text }); this.render(); }
  private render(): void {
    const model = this.viewModel(); this.header.setContent(model.header); this.status.setContent(model.status); this.history.setContent(model.history); this.history.setScrollPerc(100); this.screen.render();
  }
  private async submit(raw: string): Promise<void> {
    let value = raw.trim();
    if (this.commandPalette.snapshot().open) value = this.commandPalette.accept() ?? value;
    this.hidePalette(); this.input.clearValue(); this.input.focus();
    if (!value) return this.render();
    this.entries.push({ role: "user", text: value });
    if (!value.startsWith("/")) this.entries.push({ role: "warning", text: "⠋ Analizando tarea..." });
    this.render();
    if (await this.session.handle(value) === "exit") this.close();
  }
  private handleKey(key: { name?: string }): void {
    const current = this.input.getValue();
    if (key.name === "escape") return;
    if (key.name === "up" && this.commandPalette.snapshot().open) { this.commandPalette.move(-1); return this.renderPalette(); }
    if (key.name === "down" && this.commandPalette.snapshot().open) { this.commandPalette.move(1); return this.renderPalette(); }
    if (key.name === "tab") {
      const completed = this.commandPalette.complete(current);
      if (completed) { this.input.setValue(completed); this.refreshPalette(completed); }
      return;
    }
    setImmediate(() => this.refreshPalette(this.input.getValue()));
  }
  private refreshPalette(value: string): void {
    if (value.startsWith("/")) { this.commandPalette.update(value); this.renderPalette(); }
    else this.hidePalette();
  }
  private renderPalette(): void {
    const state = this.commandPalette.snapshot();
    if (!state.open || !state.items.length) { this.palette.hide(); this.screen.render(); return; }
    this.palette.setItems(state.items.map((item) => `{bold}${item.command}{/bold}  {gray-fg}${item.description}{/gray-fg}`));
    this.palette.select(state.selected); this.palette.show(); this.screen.render();
  }
  private acceptPalette(index?: number): void {
    if (index !== undefined) { const delta = index - this.commandPalette.snapshot().selected; if (delta) this.commandPalette.move(delta); }
    const selected = this.commandPalette.accept();
    if (!selected) return;
    this.input.setValue(selected); this.hidePalette(); this.input.focus(); this.screen.render();
  }
  private hidePalette(): void { this.commandPalette.close(); this.palette.hide(); this.screen.render(); }
  private close(): void { if (!this.closed) { this.closed = true; this.screen.destroy(); } }
}
