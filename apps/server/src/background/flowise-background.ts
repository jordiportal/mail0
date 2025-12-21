/**
 * Flowise Service para Background Workers
 * Versión que funciona con Node.js sin depender de Cloudflare Workers
 */

/**
 * Flowise Service - Wrapper para interactuar con Flowise API
 */
export class FlowiseService {
  private baseURL: string;
  private summaryEndpoint: string;
  private embeddingEndpoint: string;
  private ragEndpoint: string;
  private apiKey: string;

  constructor() {
    this.baseURL = process.env.FLOWISE_BASE_URL || 'http://192.168.7.101:3002';
    this.summaryEndpoint = process.env.FLOWISE_SUMMARY_ENDPOINT || '74ebdc4c-481c-429c-b528-1c993c5586ca';
    this.embeddingEndpoint = process.env.FLOWISE_EMBEDDING_ENDPOINT || '74ebdc4c-481c-429c-b528-1c993c5586ca';
    this.ragEndpoint = process.env.FLOWISE_RAG_ENDPOINT || '068a3579-5168-4dd4-ad41-ee3314640daf';
    this.apiKey = process.env.FLOWISE_API_KEY || '';
  }

  /**
   * Mapea modelos de Cloudflare a endpoints de Flowise
   */
  private getEndpointForModel(modelId: string): string {
    const modelMap: Record<string, string> = {
      '@cf/facebook/bart-large-cnn': this.summaryEndpoint,
      '@cf/meta/llama-4-scout-17b-16e-instruct': this.summaryEndpoint,
      '@cf/baai/bge-large-en-v1.5': this.embeddingEndpoint,
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast': this.summaryEndpoint,
    };
    return modelMap[modelId] || this.summaryEndpoint;
  }

  /**
   * Construye el prompt según el tipo de modelo y input
   */
  private buildPrompt(modelId: string, input: any): string {
    if (modelId === '@cf/facebook/bart-large-cnn') {
      return `Summarize the following text in a concise way:\n\n${input.input_text || input.text || ''}`;
    }

    if (modelId === '@cf/meta/llama-4-scout-17b-16e-instruct') {
      if (input.messages && Array.isArray(input.messages)) {
        const promptParts: string[] = [];
        const systemMessage = input.messages.find((m: any) => m.role === 'system');
        if (systemMessage) {
          promptParts.push(`System: ${systemMessage.content}`);
        }
        const conversationMessages = input.messages.filter((m: any) => m.role !== 'system');
        for (const msg of conversationMessages) {
          const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : msg.role;
          promptParts.push(`${roleLabel}: ${msg.content}`);
        }
        return promptParts.join('\n\n');
      }
      return input.input_text || input.text || '';
    }

    if (modelId === '@cf/baai/bge-large-en-v1.5') {
      return input.text || '';
    }

    return input.input_text || input.text || JSON.stringify(input);
  }

  /**
   * Adapta la respuesta de Flowise al formato esperado
   */
  private adaptResponse(modelId: string, flowiseResponse: any): any {
    if (modelId === '@cf/facebook/bart-large-cnn') {
      return {
        summary: flowiseResponse.text || flowiseResponse.data?.text || flowiseResponse.response || '',
      };
    }

    if (modelId === '@cf/baai/bge-large-en-v1.5') {
      const embedding = flowiseResponse.data?.embedding || flowiseResponse.embedding || flowiseResponse.data;
      return {
        data: Array.isArray(embedding) ? embedding : [embedding],
      };
    }

    const textResponse = flowiseResponse.text || flowiseResponse.data?.text || flowiseResponse.response || '';
    return {
      response: typeof textResponse === 'string' ? textResponse : String(textResponse),
    };
  }

  /**
   * Ejecuta un modelo de Flowise
   */
  async run(modelId: string, input: any, options?: any): Promise<any> {
    try {
      const endpoint = this.getEndpointForModel(modelId);
      const prompt = this.buildPrompt(modelId, input);

      console.log(`[FLOWISE_BG] Calling ${this.baseURL}/api/v1/prediction/${endpoint}`);

      const response = await fetch(`${this.baseURL}/api/v1/prediction/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify({
          question: prompt,
          overrideConfig: {
            sessionId: options?.gateway?.id || undefined,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[FLOWISE_BG] Error calling Flowise API: ${response.status} - ${errorText}`);
        throw new Error(`Flowise API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return this.adaptResponse(modelId, data);
    } catch (error) {
      console.error(`[FLOWISE_BG] Error in run() for model ${modelId}:`, error);
      throw error;
    }
  }
}

