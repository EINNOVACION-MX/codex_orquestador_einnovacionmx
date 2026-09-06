import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReasoningSupported, supportedReasoningFor } from "../src/config.ts";

describe("model configuration", () => {
  it("does not advertise unsupported no-reasoning mode for Astra", () => {
    assert.equal(isReasoningSupported("astra", "none"), false);
    assert.equal(supportedReasoningFor("astra", "none"), "medium");
  });

  it("keeps all configured levels for Luna", () => {
    assert.equal(isReasoningSupported("luna", "none"), true);
    assert.equal(isReasoningSupported("luna", "max"), true);
  });
});
