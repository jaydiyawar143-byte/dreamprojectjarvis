export class WhatsAppIntegration {
  constructor(private config: { phoneNumberId: string; accessToken: string }) {}

  async sendMessage(_to: string, _message: string): Promise<unknown> {
    // In production: send via WhatsApp Business API using this.config
    void this.config;
    return { success: true };
  }

  async sendTemplate(_to: string, _templateName: string, _params: string[]): Promise<unknown> {
    return { success: true };
  }

  async getMessages(_phoneNumberId: string): Promise<unknown[]> {
    return [];
  }
}
