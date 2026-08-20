// ---------------------------------------------------------------------------
// IEmbeddingProvider — Abstraction for text embedding services
// ---------------------------------------------------------------------------

export interface EmbeddingRequest {
  input: string | string[];
  model?: string;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
}

export interface IEmbeddingProvider {
  readonly id: string;
  readonly name: string;
  readonly dimensions: number;

  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  isAvailable(): Promise<boolean>;
}
