export class MetaIntegration {
  constructor(private config: { accessToken: string; adAccountId: string }) {}

  async getCampaigns(): Promise<unknown[]> {
    // In production: use this.config.accessToken
    void this.config;
    return [];
  }

  async getAdSets(_campaignId: string): Promise<unknown[]> {
    return [];
  }

  async getInsights(_adAccountId: string, _dateRange: { start: string; end: string }): Promise<unknown> {
    return {};
  }

  async getPagePosts(_pageId: string): Promise<unknown[]> {
    return [];
  }
}
