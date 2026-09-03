import {
  DEFAULT_RETRIEVAL_TOP_K,
  DEFAULT_SIMILARITY_THRESHOLD,
  JarvisError,
  KNOWLEDGE_RETRIEVAL_VERSION,
  MAX_RETRIEVAL_TOP_K,
  MAX_SIMILARITY_THRESHOLD,
  MIN_SIMILARITY_THRESHOLD,
  type EmbeddingResponse,
  type IEmbeddingProvider,
  type IKnowledgeRetriever,
  type IKnowledgeRepository,
  type KnowledgeChunkMatch,
  type KnowledgeChunkSearchOptions,
  type KnowledgeRetrievalOptions,
  type KnowledgeRetrievalResult,
  type ResolvedRetrievalOptions,
  type RetrievedChunk,
} from "@jarvis/core";
import {
  validateEmbeddingBatch,
  wrapProviderFailure,
} from "../embedding/embedding-validator.js";
import { compareRetrievedChunks, toRetrievedChunk } from "./retrieval-mapper.js";

/**
 * Sprint 3.5 — knowledge vector retrieval.
 *
 * Embeds a text query through the same `IEmbeddingProvider` abstraction
 * Sprint 3.4 uses, then asks the Sprint 3.1 repository for the nearest stored
 * chunks by cosine distance. It returns ranked passages and stops there: no
 * prompt assembly, no answer generation, no orchestration.
 *
 * Both collaborators are injected and neither is constructed here, so swapping
 * the embedding backend or the store is a wiring change rather than an edit to
 * this file.
 *
 * The query embedding is validated with the Sprint 3.4 validator, unchanged.
 * A query vector is subject to exactly the failures a chunk vector is — wrong
 * count, wrong dimensions, NaN — and a wrong-sized query vector is worse, since
 * it makes every distance in the search meaningless rather than one row.
 */

export interface KnowledgeRetrievalServiceConfig extends KnowledgeRetrievalOptions {
  /** The embedding backend. Required — this service never creates one. */
  provider: IEmbeddingProvider;
  /** The knowledge store to search. Required. */
  repository: IKnowledgeRepository;
}

export function resolveRetrievalOptions(
  options: KnowledgeRetrievalOptions = {}
): ResolvedRetrievalOptions {
  const topK = options.topK ?? DEFAULT_RETRIEVAL_TOP_K;
  const similarityThreshold =
    options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  if (!Number.isInteger(topK) || topK <= 0) {
    throw new JarvisError("INVALID_REQUEST", "topK must be a positive integer", {
      topK,
    });
  }
  if (topK > MAX_RETRIEVAL_TOP_K) {
    throw new JarvisError(
      "INVALID_REQUEST",
      `topK must not exceed ${MAX_RETRIEVAL_TOP_K}`,
      { topK, maxTopK: MAX_RETRIEVAL_TOP_K }
    );
  }
  if (!Number.isFinite(similarityThreshold)) {
    throw new JarvisError(
      "INVALID_REQUEST",
      "similarityThreshold must be a finite number",
      { similarityThreshold }
    );
  }
  if (
    similarityThreshold < MIN_SIMILARITY_THRESHOLD ||
    similarityThreshold > MAX_SIMILARITY_THRESHOLD
  ) {
    throw new JarvisError(
      "INVALID_REQUEST",
      `similarityThreshold must be between ${MIN_SIMILARITY_THRESHOLD} and ${MAX_SIMILARITY_THRESHOLD}`,
      { similarityThreshold }
    );
  }

  const filters: ResolvedRetrievalOptions["filters"] = {};
  if (options.documentIds !== undefined) filters.documentIds = [...options.documentIds];
  if (options.documentTypes !== undefined) {
    filters.documentTypes = [...options.documentTypes];
  }
  if (options.sources !== undefined) filters.sources = [...options.sources];
  if (options.statuses !== undefined) filters.statuses = [...options.statuses];

  const resolved: ResolvedRetrievalOptions = { topK, similarityThreshold, filters };
  if (options.model !== undefined) resolved.model = options.model;
  return resolved;
}

/**
 * Per-call options override the constructor defaults field by field. A call
 * that names no filter inherits the service defaults; a call that names one
 * replaces that filter outright rather than adding to it, so a narrower request
 * can never be silently widened by a default set elsewhere.
 */
function mergeRetrievalOptions(
  defaults: ResolvedRetrievalOptions,
  overrides: KnowledgeRetrievalOptions
): KnowledgeRetrievalOptions {
  const merged: KnowledgeRetrievalOptions = {
    topK: overrides.topK ?? defaults.topK,
    similarityThreshold:
      overrides.similarityThreshold ?? defaults.similarityThreshold,
  };

  const model = overrides.model ?? defaults.model;
  if (model !== undefined) merged.model = model;

  const documentIds = overrides.documentIds ?? defaults.filters.documentIds;
  if (documentIds !== undefined) merged.documentIds = documentIds;

  const documentTypes = overrides.documentTypes ?? defaults.filters.documentTypes;
  if (documentTypes !== undefined) merged.documentTypes = documentTypes;

  const sources = overrides.sources ?? defaults.filters.sources;
  if (sources !== undefined) merged.sources = sources;

  const statuses = overrides.statuses ?? defaults.filters.statuses;
  if (statuses !== undefined) merged.statuses = statuses;

  return merged;
}

export class KnowledgeRetrievalService implements IKnowledgeRetriever {
  private readonly provider: IEmbeddingProvider;
  private readonly repository: IKnowledgeRepository;
  private readonly defaults: ResolvedRetrievalOptions;

  constructor(config: KnowledgeRetrievalServiceConfig) {
    if (!config?.provider) {
      throw new JarvisError("INVALID_REQUEST", "An embedding provider is required");
    }
    if (!config?.repository) {
      throw new JarvisError("INVALID_REQUEST", "A knowledge repository is required");
    }
    this.provider = config.provider;
    this.repository = config.repository;
    // Validated at construction so misconfiguration surfaces on creation
    // rather than on the first query, matching chunking and embedding.
    this.defaults = resolveRetrievalOptions(config);
  }

  async retrieve(
    userId: string,
    query: string,
    options?: KnowledgeRetrievalOptions
  ): Promise<KnowledgeRetrievalResult> {
    if (typeof userId !== "string" || userId.trim().length === 0) {
      throw new JarvisError("INVALID_REQUEST", "A userId is required to retrieve");
    }

    const resolved = options
      ? resolveRetrievalOptions(mergeRetrievalOptions(this.defaults, options))
      : this.defaults;

    const text = typeof query === "string" ? query.trim() : "";

    // An empty query is an ordinary outcome, not a failure: it short-circuits
    // before the provider and the database, so a blank search box costs
    // nothing. `emptyQuery` is what lets a caller tell this apart from a real
    // query that simply matched nothing.
    if (text.length === 0) {
      return this.emptyResult(query, resolved);
    }

    const embedded = await this.embedQuery(text, resolved);
    const matches = await this.search(userId, embedded.vector, resolved);

    // The threshold, ordering and topK are all enforced again here, on top of
    // what the store already did. The repository is an interface, and this is
    // where the contract in `IKnowledgeRetriever` is actually guaranteed —
    // every implementation gets held to the same ranking, not just the SQL one.
    const results: RetrievedChunk[] = matches
      .map(toRetrievedChunk)
      .filter((chunk) => chunk.score >= resolved.similarityThreshold)
      .sort(compareRetrievedChunks)
      .slice(0, resolved.topK);

    return {
      query,
      results,
      resultCount: results.length,
      topK: resolved.topK,
      similarityThreshold: resolved.similarityThreshold,
      dimensions: this.provider.dimensions,
      model: embedded.model || resolved.model || "",
      retrievalVersion: KNOWLEDGE_RETRIEVAL_VERSION,
      emptyQuery: false,
    };
  }

  private emptyResult(
    query: string,
    resolved: ResolvedRetrievalOptions
  ): KnowledgeRetrievalResult {
    return {
      query: typeof query === "string" ? query : "",
      results: [],
      resultCount: 0,
      topK: resolved.topK,
      similarityThreshold: resolved.similarityThreshold,
      dimensions: this.provider.dimensions,
      model: resolved.model ?? "",
      retrievalVersion: KNOWLEDGE_RETRIEVAL_VERSION,
      emptyQuery: true,
    };
  }

  private async embedQuery(
    text: string,
    resolved: ResolvedRetrievalOptions
  ): Promise<{ vector: number[]; model: string }> {
    let response: EmbeddingResponse;
    try {
      response = await this.provider.embed(
        resolved.model ? { input: [text], model: resolved.model } : { input: [text] }
      );
    } catch (error) {
      // Passes an existing JarvisError through untouched, so a provider's
      // RATE_LIMITED stays distinguishable from a malformed response.
      wrapProviderFailure(error, {
        provider: this.provider.id,
        stage: "query-embedding",
      });
    }

    const [vector] = validateEmbeddingBatch(
      response!.embeddings,
      1,
      this.provider.dimensions,
      { provider: this.provider.id, stage: "query-embedding" }
    );

    // The provider reports the model it actually used, which may differ from
    // what was requested (aliases, version pinning). Record that, not the ask.
    return { vector: vector!, model: response!.model ?? "" };
  }

  private async search(
    userId: string,
    embedding: number[],
    resolved: ResolvedRetrievalOptions
  ): Promise<KnowledgeChunkMatch[]> {
    const searchOptions: KnowledgeChunkSearchOptions = {
      limit: resolved.topK,
      similarityThreshold: resolved.similarityThreshold,
    };

    const { documentIds, documentTypes, sources, statuses } = resolved.filters;
    if (documentIds !== undefined) searchOptions.documentIds = documentIds;
    if (documentTypes !== undefined) searchOptions.documentTypes = documentTypes;
    if (sources !== undefined) searchOptions.sources = sources;
    if (statuses !== undefined) searchOptions.statuses = statuses;

    let matches: KnowledgeChunkMatch[];
    try {
      matches = await this.repository.searchChunksByEmbedding(
        userId,
        embedding,
        searchOptions
      );
    } catch (error) {
      if (error instanceof JarvisError) throw error;
      throw new JarvisError(
        "KNOWLEDGE_RETRIEVAL_FAILED",
        "Knowledge chunk similarity search failed",
        {
          topK: resolved.topK,
          similarityThreshold: resolved.similarityThreshold,
          cause: error instanceof Error ? error.message : String(error),
        }
      );
    }

    if (!Array.isArray(matches)) {
      throw new JarvisError(
        "KNOWLEDGE_RETRIEVAL_FAILED",
        "Knowledge store returned a non-array search result",
        { received: typeof matches }
      );
    }

    return matches;
  }
}
