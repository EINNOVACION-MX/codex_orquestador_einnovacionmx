import assert from "node:assert/strict";
import { it } from "node:test";
import { CodexAdapter } from "../src/codex/adapter.ts";

const integrationEnabled = process.env.CODEX_AUTOMODEL_INTEGRATION === "1";

it("discovers the local Codex model catalog without starting a turn", { skip: !integrationEnabled }, async () => {
  const adapter = await CodexAdapter.connect();
  try {
    const models = await adapter.discoverModels();
    assert.ok(models.length > 0, "Codex should expose at least one model");
  } finally {
    await adapter.close();
  }
});
