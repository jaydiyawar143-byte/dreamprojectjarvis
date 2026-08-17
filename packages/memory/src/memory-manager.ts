import OpenAI from "openai";

export class MemoryManager {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return response.data[0].embedding;
  }

  async store(
    conversationId: string,
    content: string,
    _metadata?: Record<string, unknown>
  ): Promise<void> {
    const embedding = await this.embed(content);
    // In production: store embedding in PostgreSQL with pgvector
    void embedding;
    console.log(`[MEMORY] Stored for conversation ${conversationId}`);
  }

  async recall(
    _conversationId: string,
    _query: string,
    _limit?: number
  ): Promise<string[]> {
    // In production: similarity search via pgvector
    return [];
  }
}
