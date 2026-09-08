import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexCapabilityRegistry, CX_COMMANDS } from "../src/capabilities/codex-capability-registry.ts";
import { CommandPalette } from "../src/cli/command-palette.ts";
import { CX_AGENTS, getCxAgent, strongerModel } from "../src/agents/cx-agent-registry.ts";
import type { DiscoveredCodexModel, JsonRecord } from "../src/codex/types.ts";

const terra: DiscoveredCodexModel = { logicalName: "terra", realModelId: "gpt-5.6-terra", displayName: "Terra", reasoningLevels: ["low", "medium", "high"], available: true, isDefault: true };
class Client {
  public readonly requests: string[] = [];
  public async discoverModels(): Promise<DiscoveredCodexModel[]> { return [terra]; }
  public async requestCapability<T>(method: string, _params: JsonRecord): Promise<T> {
    this.requests.push(method);
    const responses: Record<string, unknown> = {
      "skills/list": { data: [{ cwd: "C:/workspace", skills: [{ name: "openai-docs", description: "Official docs" }] }] },
      "plugin/list": { marketplaces: [{ name: "local", plugins: [{ id: "cx-native-bridge", name: "CX Native Bridge", enabled: true }] }] },
      "mcpServerStatus/list": { data: [{ name: "cx", status: "connected", tools: { cx_route: { name: "cx_route", description: "Route" } } }] },
      "experimentalFeature/list": { data: [{ name: "feature-x", enabled: true }] },
    };
    return responses[method] as T;
  }
}

describe("CodexCapabilityRegistry", () => {
  it("uses only discovery endpoints and preserves unavailable configured models", async () => {
    const client = new Client(); const result = await new CodexCapabilityRegistry(client).discover("C:/workspace");
    assert.equal(result.models.find((model) => model.logicalName === "terra")?.available, true);
    assert.equal(result.models.find((model) => model.logicalName === "astra")?.available, false);
    assert.deepEqual(result.reasoningLevels, ["low", "medium", "high"]);
    assert.equal(result.skills[0]?.name, "openai-docs"); assert.equal(result.plugins[0]?.origin, "plugin");
    assert.equal(result.mcpServers[0]?.toolCount, 1); assert.ok(result.tools.some((tool) => tool.name === "cx_route"));
    assert.equal(result.features["feature-x"], true);
    assert.equal(client.requests.some((method) => method.startsWith("turn/")), false);
  });
  it("keeps native agents unavailable when the public App Server has no agent-list API", async () => {
    const result = await new CodexCapabilityRegistry(new Client()).discover();
    assert.equal(result.agents[0]?.origin, "unavailable"); assert.match(result.agents[0]?.description ?? "", /no public agent-list/i);
  });
  it("keeps one command source for palette and command help", () => {
    assert.ok(CX_COMMANDS.some((command) => command.command === "/agents"));
    assert.ok(CX_COMMANDS.some((command) => command.command === "/tools"));
  });
});

describe("CommandPalette", () => {
  it("opens on slash, filters commands, navigates and accepts selection", () => {
    const palette = new CommandPalette(CX_COMMANDS);
    assert.equal(palette.show("/").open, true); assert.ok(palette.snapshot().items.length > 10);
    assert.deepEqual(palette.update("/ag").items.map((item) => item.command), ["/agents"]);
    palette.show("/"); palette.move(1); assert.equal(palette.accept(), CX_COMMANDS[1]?.command);
    assert.equal(palette.close().open, false);
  });
  it("autocompletes commands and supported arguments", () => {
    const palette = new CommandPalette(CX_COMMANDS);
    palette.show("/mo"); assert.equal(palette.complete("/mo"), "/model");
    assert.equal(palette.complete("/model"), "/model ");
    assert.equal(palette.complete("/model "), "/model auto");
    assert.equal(palette.complete("/profile e"), "/profile eco");
  });
});

describe("CX agents", () => {
  it("keeps CX agents separate and makes Security a Sol minimum", () => {
    assert.equal(CX_AGENTS.some((agent) => agent.id === "security"), true);
    assert.equal(getCxAgent("security")?.minimumModel, "sol");
    assert.equal(strongerModel("luna", getCxAgent("security")?.minimumModel), "sol");
  });
});
