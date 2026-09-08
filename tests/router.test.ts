import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeTask } from "../src/router.ts";

describe("Task Classifier and Model Router", () => {
  const domainCases = [
    ["Implementa una landing page con Next.js", "web-development"],
    ["Crea un endpoint API para login", "backend"],
    ["Cambia el padding del navbar", "frontend"],
    ["Crea una migración de Postgres", "database"],
    ["Implementa módulo de clientes con Supabase", "crm"],
    ["Crea una automatización para avisar de nuevos leads", "automation"],
    ["Configura un workflow en n8n para sincronizar contactos", "n8n"],
    ["Crea un agente IA con RAG", "ai-agents"],
    ["Depura un error intermitente", "debugging"],
    ["Diseña la arquitectura de microservicios", "architecture"],
    ["Haz un threat model de la aplicación", "cybersecurity"],
  ] as const;

  for (const [prompt, domain] of domainCases) {
    it(`classifies ${domain} tasks with an explicit rule`, () => {
      assert.equal(routeTask({ prompt }).domain, domain);
    });
  }

  it("routes a small frontend style change to Luna", () => {
    const result = routeTask({ prompt: "Cambia el padding del navbar" });

    assert.deepEqual(result, {
      domain: "frontend",
      taskType: "style-change",
      complexity: 1,
      risk: 1,
      selectedModel: "luna",
      reasoning: "low",
      confidence: 0.88,
      reasons: ["small isolated change"],
    });
  });

  it("routes a CRM feature with Supabase to Terra", () => {
    const result = routeTask({ prompt: "Implementa módulo de clientes con Supabase" });

    assert.deepEqual(
      {
        domain: result.domain,
        taskType: result.taskType,
        complexity: result.complexity,
        risk: result.risk,
        selectedModel: result.selectedModel,
        reasoning: result.reasoning,
      },
      {
      domain: "crm",
      taskType: "feature",
      complexity: 5,
      risk: 3,
      selectedModel: "terra",
      reasoning: "medium",
      },
    );
    assert.deepEqual(result.reasons, [
        "feature full-stack",
        "database modification",
        "moderate implementation complexity",
    ]);
  });

  it("routes payment race-condition analysis to Sol", () => {
    const result = routeTask({ prompt: "Analiza race condition en pagos" });

    assert.deepEqual(
      {
        domain: result.domain,
        taskType: result.taskType,
        complexity: result.complexity,
        risk: result.risk,
        selectedModel: result.selectedModel,
        reasoning: result.reasoning,
      },
      {
      domain: "debugging",
      taskType: "analysis",
      complexity: 6,
      risk: 5,
      selectedModel: "sol",
      reasoning: "high",
      },
    );
    assert.ok(result.reasons.includes("concurrency or idempotency analysis"));
  });

  it("escalates a critical architecture problem after two Sol failures to Astra", () => {
    const result = routeTask({
      prompt: "Sol ya intentó dos veces resolver un problema arquitectónico crítico",
      previousModel: "sol",
      failedAttempts: 2,
    });

    assert.deepEqual(
      {
        domain: result.domain,
        taskType: result.taskType,
        complexity: result.complexity,
        risk: result.risk,
        selectedModel: result.selectedModel,
        reasoning: result.reasoning,
      },
      {
      domain: "architecture",
      taskType: "architecture",
      complexity: 9,
      risk: 4,
      selectedModel: "astra",
      reasoning: "xhigh",
      },
    );
  });

  it("preserves Plus efficiency in economy mode", () => {
    const result = routeTask({
      prompt: "Analiza race condition en pagos",
      budgetProfile: "economy",
    });

    assert.equal(result.selectedModel, "terra");
    assert.equal(result.reasoning, "high");
  });

  it("honors an explicit model override", () => {
    const result = routeTask({
      prompt: "Cambia el padding del navbar",
      modelOverride: "sol",
    });

    assert.equal(result.selectedModel, "sol");
    assert.equal(result.reasoning, "low");
  });

  it("starts evidence-based database and business-logic investigations at Terra Medium", () => {
    for (const prompt of [
      "Verifica el reporte existente de la base de datos y corrobora la lógica de negocio en varios archivos",
      "Investiga el error de debugging en múltiples archivos y revisa el informe existente",
    ]) {
      const result = routeTask({ prompt });
      assert.equal(result.selectedModel, "terra");
      assert.equal(result.reasoning, "medium");
    }
  });
});
