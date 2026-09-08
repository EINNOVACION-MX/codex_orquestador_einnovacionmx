import type { CommandDefinition } from "../capabilities/types.ts";

export interface PaletteState { open: boolean; query: string; selected: number; items: CommandDefinition[]; }

/** Pure state machine used by the Blessed overlay and unit tests. */
export class CommandPalette {
  private readonly commands: readonly CommandDefinition[];
  private state: PaletteState;
  public constructor(commands: readonly CommandDefinition[]) { this.commands = commands; this.state = { open: false, query: "", selected: 0, items: [] }; }
  public snapshot(): PaletteState { return { ...this.state, items: [...this.state.items] }; }
  public show(query = "/"): PaletteState { this.state = { open: true, query, selected: 0, items: this.filter(query) }; return this.snapshot(); }
  public update(query: string): PaletteState { if (!this.state.open && query.startsWith("/")) return this.show(query); this.state = { open: this.state.open, query, selected: 0, items: this.filter(query) }; return this.snapshot(); }
  public move(delta: number): PaletteState { if (!this.state.items.length) return this.snapshot(); this.state.selected = (this.state.selected + delta + this.state.items.length) % this.state.items.length; return this.snapshot(); }
  public accept(): string | undefined { return this.state.items[this.state.selected]?.command; }
  public close(): PaletteState { this.state = { open: false, query: "", selected: 0, items: [] }; return this.snapshot(); }
  public complete(input: string): string | undefined {
    const [command, argument] = input.trimStart().split(/\s+/, 2);
    const match = this.commands.find((candidate) => candidate.command === command);
    if (!match) return this.accept();
    if (argument === undefined && !input.endsWith(" ")) return `${match.command} `;
    if (argument === undefined || argument === "") return match.arguments?.[0] ? `${match.command} ${match.arguments[0]}` : `${match.command} `;
    const candidate = match.arguments?.find((value) => value.startsWith(argument.toLowerCase()));
    return candidate ? `${match.command} ${candidate}` : undefined;
  }
  private filter(query: string): CommandDefinition[] { const key = query.trim().toLowerCase(); return this.commands.filter((command) => !key || command.command.startsWith(key)); }
}
