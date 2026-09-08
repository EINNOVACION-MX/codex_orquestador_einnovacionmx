import type {
  ClassificationRequest,
  RoutingSignals,
  TaskDomain,
  TaskType,
} from "./types.ts";

export interface ClassificationDraft {
  domain: TaskDomain;
  taskType: TaskType;
  complexity: number;
  risk: number;
  confidence: number;
  reasons: string[];
  signals: RoutingSignals;
}

const includesAny = (text: string, terms: readonly string[]): boolean =>
  terms.some((term) => text.includes(term));

function normalized(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es-MX");
}

function detectDomain(text: string): TaskDomain {
  if (includesAny(text, ["n8n", "node-red"])) return "n8n";
  if (includesAny(text, ["automatizacion", "workflow", "zapier", "make.com", "integracion automatica"])) return "automation";
  if (includesAny(text, ["crm", "clientes", "leads", "contactos", "pipeline de ventas"])) return "crm";
  if (includesAny(text, ["ciberseguridad", "vulnerabilidad", "pentest", "threat model", "seguridad ofensiva", "security audit"])) return "cybersecurity";
  if (includesAny(text, ["arquitectura", "arquitecton", "microservicios", "sistema distribuido", "diseno de sistema", "system design"])) return "architecture";
  if (includesAny(text, ["race condition", "debug", "depura", "error intermitente", "stack trace", "no funciona", "bug"])) return "debugging";
  if (includesAny(text, ["supabase", "postgres", "mysql", "mongodb", "migracion", "schema", "base de datos", "rls"])) return "database";
  if (includesAny(text, ["api", "webhook", "server action", "backend", "autenticacion", "stripe", "servidor"])) return "backend";
  if (includesAny(text, ["padding", "css", "tailwind", "navbar", "responsive", "frontend", "componente", "interfaz de usuario"])) return "frontend";
  if (includesAny(text, ["agente ia", "agentes ia", "llm", "prompt", "rag", "tool calling"])) return "ai-agents";
  if (includesAny(text, ["pagina web", "sitio web", "next.js", "react", "web development"])) return "web-development";
  return "general";
}

function detectTaskType(text: string, domain: TaskDomain): TaskType {
  if (domain === "cybersecurity") return "security";
  if (domain === "architecture") return "architecture";
  if (domain === "automation" || domain === "n8n") return "automation";
  if (includesAny(text, ["analiza", "investiga", "diagnostica", "revisa"])) return "analysis";
  if (includesAny(text, ["corrige", "arregla", "depura", "fix", "bug"])) return "bugfix";
  if (includesAny(text, ["padding", "color", "texto", "copy", "css", "estilo", "responsive"])) return "style-change";
  if (includesAny(text, ["implementa", "crea", "agrega", "modulo", "feature", "integra"])) return "feature";
  return "general";
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason) && reasons.length < 3) reasons.push(reason);
}

function inferredAttempts(text: string, request: ClassificationRequest): number {
  if (request.failedAttempts !== undefined) return Math.max(0, request.failedAttempts);
  if (includesAny(text, ["dos veces", "2 veces", "dos intentos", "2 intentos"])) return 2;
  if (includesAny(text, ["ya intento", "ya intentaron", "fallo antes"])) return 1;
  return 0;
}

export function classifyTask(request: ClassificationRequest): ClassificationDraft {
  const text = normalized(request.prompt);
  const domain = detectDomain(text);
  const taskType = detectTaskType(text, domain);
  const reasons: string[] = [];
  let complexity = taskType === "style-change" ? 1 : taskType === "feature" ? 3 : 2;
  let risk = 1;

  const detectedDatabaseWork = includesAny(text, [
    "supabase", "postgres", "mysql", "mongodb", "migracion", "schema", "base de datos", "rls",
  ]);
  const detectedPaymentOrProductionWork = includesAny(text, [
    "pago", "pagos", "stripe", "produccion", "production", "facturacion", "factura",
  ]);
  const detectedConcurrency = includesAny(text, [
    "race condition", "concurrencia", "idempotencia", "deadlock", "webhooks duplicados",
  ]);
  const isCritical = includesAny(text, ["critico", "critical", "incidente", "caida", "perdida de datos"]);
  const failedAttempts = inferredAttempts(text, request);
  const investigationIntent = includesAny(text, ["verifica", "verificar", "investiga", "investigar", "corrobora", "corroborar", "revisa", "revisar", "analiza", "analizar", "diagnostica", "diagnosticar"]);
  const complexInvestigationScope = includesAny(text, ["base de datos", "database", "logica de negocio", "business logic", "debug", "bug", "error", "reporte", "report", "varios archivos", "multiples archivos", "multiple files", "existing report", "informe existente"]);

  if (taskType === "feature" && (domain === "crm" || detectedDatabaseWork || domain === "backend")) {
    complexity += 1;
    addReason(reasons, "feature full-stack");
  }
  if (detectedDatabaseWork) {
    complexity += 1;
    risk += 2;
    addReason(reasons, "database modification");
  }
  if (domain === "automation" || domain === "n8n" || domain === "ai-agents") {
    complexity += 1;
    risk += 1;
    addReason(reasons, "external workflow integration");
  }
  if (domain === "architecture") {
    complexity += 3;
    risk += 2;
    addReason(reasons, "cross-system architecture");
  }
  if (domain === "cybersecurity") {
    complexity += 2;
    risk += 3;
    addReason(reasons, "security-sensitive scope");
  }
  if (detectedConcurrency) {
    complexity += 3;
    risk += 2;
    addReason(reasons, "concurrency or idempotency analysis");
  }
  if (detectedPaymentOrProductionWork) {
    complexity += 1;
    risk += 2;
    addReason(reasons, "payment or production impact");
  }
  if (isCritical) {
    complexity += 2;
    risk += 1;
    addReason(reasons, "critical business impact");
  }
  if (failedAttempts > 0) {
    complexity += Math.min(failedAttempts, 2);
    addReason(reasons, "previous attempts did not resolve the issue");
  }
  if (investigationIntent && complexInvestigationScope) {
    complexity = Math.max(complexity, 3);
    risk = Math.max(risk, 2);
    addReason(reasons, "investigation across existing implementation");
  }

  complexity = Math.min(10, complexity);
  risk = Math.min(5, risk);
  if (reasons.length === 0 && complexity <= 2) addReason(reasons, "small isolated change");
  if (reasons.length < 3 && complexity >= 3 && complexity <= 5) addReason(reasons, "moderate implementation complexity");

  const confidence = Math.min(
    0.97,
    0.66 + (domain === "general" ? 0 : 0.1) + (taskType === "general" ? 0 : 0.08) + Math.min(reasons.length, 3) * 0.04,
  );

  return {
    domain,
    taskType,
    complexity,
    risk,
    confidence: Number(confidence.toFixed(2)),
    reasons,
    signals: {
      failedAttempts,
      detectedDatabaseWork,
      detectedPaymentOrProductionWork,
      detectedConcurrency,
      isCritical,
    },
  };
}
