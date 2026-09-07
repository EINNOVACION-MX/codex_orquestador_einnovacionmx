import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetController } from "../src/budget/budget-controller.ts";
import type { UsageSnapshot } from "../src/budget/types.ts";
import { routeTask } from "../src/router.ts";
import type { ModelId } from "../src/types.ts";

function usage(fiveHour?: number, weekly?: number): UsageSnapshot {
  return {
    source: "manual",
    capturedAt: "2026-09-06T12:00:00.000Z",
    ...(fiveHour !== undefined ? { fiveHour: { remainingPercent: fiveHour } } : {}),
    ...(weekly !== undefined ? { weekly: { remainingPercent: weekly } } : {}),
  };
}

function evaluate(snapshot: UsageSnapshot | undefined, selectedModel: ModelId = "terra", minimumModel?: ModelId) {
  return new BudgetController().evaluate({
    ...(snapshot ? { usage: snapshot } : {}),
    routingDecision: { ...routeTask({ prompt: "Implementa módulo de clientes" }), selectedModel },
    ...(minimumModel ? { minimumModel } : {}),
  });
}

describe("BudgetController", () => {
  it("classifies 90% / 90% as balanced", () => {
    assert.equal(evaluate(usage(90, 90)).state, "balanced");
  });

  it("uses the most constrained window for conservative state", () => {
    assert.equal(evaluate(usage(55, 80)).state, "conservative");
  });

  it("classifies 25% / 70% as eco", () => {
    assert.equal(evaluate(usage(25, 70)).state, "eco");
  });

  it("classifies 8% / 70% as emergency", () => {
    assert.equal(evaluate(usage(8, 70)).state, "emergency");
  });

  it("classifies 80% / 15% as emergency", () => {
    assert.equal(evaluate(usage(80, 15)).state, "emergency");
  });

  it("uses unknown state with conservative behavior when usage is absent", () => {
    const decision = evaluate(undefined, "sol");
    assert.equal(decision.state, "unknown");
    assert.equal(decision.preferredModel, "terra");
  });

  it("keeps Luna in emergency", () => {
    assert.equal(evaluate(usage(8, 70), "luna").preferredModel, "luna");
  });

  it("keeps Terra in eco", () => {
    assert.equal(evaluate(usage(25, 70), "terra").preferredModel, "terra");
  });

  it("restricts an optional Sol task in eco", () => {
    const decision = evaluate(usage(25, 70), "sol");
    assert.equal(decision.preferredModel, "terra");
    assert.equal(decision.allowSol, false);
  });

  it("keeps Sol when minimumModel requires it during emergency", () => {
    const decision = evaluate(usage(8, 70), "sol", "sol");
    assert.equal(decision.preferredModel, "sol");
    assert.equal(decision.allowSol, true);
  });

  it("keeps Sol for critical security work during emergency", () => {
    const routingDecision = { ...routeTask({ prompt: "Auditoría de seguridad" }), domain: "cybersecurity" as const, risk: 5, selectedModel: "sol" as const };
    const decision = new BudgetController().evaluate({ usage: usage(8, 70), routingDecision });
    assert.equal(decision.preferredModel, "sol");
    assert.equal(decision.minimumModel, "sol");
  });

  it("does not silently degrade an Astra minimum during emergency", () => {
    const decision = evaluate(usage(8, 70), "astra", "astra");
    assert.equal(decision.preferredModel, "astra");
    assert.equal(decision.allowAstra, true);
  });

  it("rejects invalid percentages", () => {
    assert.throws(() => evaluate(usage(101, 70)), /between 0 and 100/);
  });

  it("processes a partial snapshot", () => {
    const decision = evaluate(usage(undefined, 25));
    assert.equal(decision.state, "eco");
  });
});
