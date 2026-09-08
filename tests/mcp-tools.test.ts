import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpTools } from "../src/mcp/tools.ts";

describe("CX MCP visual schemas", () => {
  it("exposes explicit image references for routing and execution", () => {
    for (const name of ["cx_route", "cx_execute"]) {
      const schema = mcpTools.find((tool) => tool.name === name)?.inputSchema;
      assert.ok(schema);
      assert.equal(schema.required.includes("task"), true);
      const images = schema.properties.images as { type?: string; items?: { properties?: Record<string, unknown> } };
      assert.equal(images.type, "array");
      assert.deepEqual(Object.keys(images.items?.properties ?? {}).sort(), ["name", "path", "url"]);
    }
  });
  it("exposes capability and agent discovery without an execution tool", () => {
    for (const name of ["cx_capabilities", "cx_agents"]) assert.ok(mcpTools.some((tool) => tool.name === name));
  });
});
