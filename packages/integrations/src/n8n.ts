export class N8nIntegration {
  constructor(private config: { baseUrl: string; apiKey: string }) {}

  async triggerWorkflow(workflowId: string, _data: Record<string, unknown>): Promise<unknown> {
    // In production: POST to n8n webhook endpoint using this.config
    void this.config;
    console.log(`[N8N] Triggering workflow ${workflowId}`);
    return { success: true };
  }

  async getWorkflowStatus(_executionId: string): Promise<unknown> {
    return { status: "completed" };
  }

  async listWorkflows(): Promise<unknown[]> {
    return [];
  }
}
