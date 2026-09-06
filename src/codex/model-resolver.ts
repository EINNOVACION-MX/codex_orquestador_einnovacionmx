import { MODEL_CONFIG } from "../config.ts";
import { MODEL_IDS, REASONING_LEVELS } from "../types.ts";
import type { ModelId, ReasoningLevel } from "../types.ts";
import type {
  CodexModelListResponse,
  CodexTransport,
  DiscoveredCodexModel,
  ModelResolution,
  ModelResolutionRequest,
} from "./types.ts";

const REASONING_RANK: Readonly<Record<ReasoningLevel, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

const FALLBACK_ORDER: Readonly<Record<ModelId, readonly ModelId[]>> = {
  astra: ["astra", "sol", "terra", "luna"],
  sol: ["sol", "terra", "luna"],
  terra: ["terra", "luna"],
  luna: ["luna"],
};

function isModelId(value: string): value is ModelId {
  return (MODEL_IDS as readonly string[]).includes(value);
}

function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

function logicalNameFor(realModelId: string): ModelId | null {
  for (const logicalName of MODEL_IDS) {
    if (MODEL_CONFIG[logicalName].codexModel === realModelId) return logicalName;
  }
  return isModelId(realModelId) ? realModelId : null;
}

function compatibleReasoning(
  available: readonly ReasoningLevel[],
  requested: ReasoningLevel,
): ReasoningLevel | null {
  const requestedRank = REASONING_RANK[requested];
  return (
    [...available]
      .sort((left, right) => REASONING_RANK[right] - REASONING_RANK[left])
      .find((level) => REASONING_RANK[level] <= requestedRank) ?? null
  );
}

export class CodexModelResolver {
  private readonly transport: CodexTransport;

  public constructor(transport: CodexTransport) {
    this.transport = transport;
  }

  public async discover(): Promise<DiscoveredCodexModel[]> {
    const response = await this.transport.request<CodexModelListResponse>("model/list", {
      limit: 100,
      includeHidden: false,
    });

    if (!Array.isArray(response.data)) {
      throw new Error("Codex returned an unexpected model/list response.");
    }

    return response.data.map((model) => ({
      logicalName: logicalNameFor(model.model || model.id),
      realModelId: model.model || model.id,
      displayName: model.displayName,
      reasoningLevels: model.supportedReasoningEfforts
        .map((option) => option.reasoningEffort)
        .filter(isReasoningLevel),
      available: !model.hidden,
      isDefault: model.isDefault,
    }));
  }

  public resolve(
    catalog: readonly DiscoveredCodexModel[],
    request: ModelResolutionRequest,
  ): ModelResolution {
    const minimumModel = request.minimumModel ?? "luna";
    const selectedRank = MODEL_CONFIG[request.selectedModel].rank;
    const minimumRank = MODEL_CONFIG[minimumModel].rank;
    const startingModel = selectedRank < minimumRank ? minimumModel : request.selectedModel;
    const candidates = FALLBACK_ORDER[startingModel].filter(
      (candidate) => MODEL_CONFIG[candidate].rank >= minimumRank,
    );

    for (const candidate of candidates) {
      const found = catalog.find(
        (model) => model.logicalName === candidate && model.available,
      );
      if (!found) continue;

      const reasoning = compatibleReasoning(found.reasoningLevels, request.requestedReasoning);
      if (!reasoning) continue;

      return {
        status: "resolved",
        requestedModel: request.selectedModel,
        resolvedModel: candidate,
        realModelId: found.realModelId,
        reasoning,
        fallbackUsed: candidate !== request.selectedModel,
      };
    }

    return {
      status: candidates.length === 0 ? "model-unavailable" : "minimum-model-unavailable",
      requestedModel: request.selectedModel,
      resolvedModel: null,
      realModelId: null,
      reasoning: null,
      fallbackUsed: false,
      error: `No available Codex model meets the ${minimumModel} minimum capability.`,
    };
  }
}
