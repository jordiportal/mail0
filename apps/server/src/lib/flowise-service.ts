import { env } from '../env';

/**
 * Flowise Service - Wrapper para interactuar con Flowise API
 * Reemplaza Cloudflare Workers AI manteniendo compatibilidad con la API existente
 */
export class FlowiseService {
  private baseURL: string;
  private summaryEndpoint: string;
  private embeddingEndpoint: string;
  private ragEndpoint: string;
  private apiKey: string;

  constructor() {
    this.baseURL = env.FLOWISE_BASE_URL || 'http://192.168.7.101:3002';
    this.summaryEndpoint = env.FLOWISE_SUMMARY_ENDPOINT || '74ebdc4c-481c-429c-b528-1c993c5586ca';
    this.embeddingEndpoint = env.FLOWISE_EMBEDDING_ENDPOINT || '74ebdc4c-481c-429c-b528-1c993c5586ca';
    this.ragEndpoint = env.FLOWISE_RAG_ENDPOINT || '068a3579-5168-4dd4-ad41-ee3314640daf';
    this.apiKey = env.FLOWISE_API_KEY || '';
  }

  /**
   * Mapea modelos de Cloudflare a endpoints de Flowise
   */
  private getEndpointForModel(modelId: string): string {
    // Mapeo de modelos de Cloudflare a endpoints de Flowise
    const modelMap: Record<string, string> = {
      '@cf/facebook/bart-large-cnn': this.summaryEndpoint,
      '@cf/meta/llama-4-scout-17b-16e-instruct': this.summaryEndpoint,
      '@cf/baai/bge-large-en-v1.5': this.embeddingEndpoint,
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast': this.summaryEndpoint,
    };

    return modelMap[modelId] || this.summaryEndpoint; // Por defecto usa el endpoint de resumen
  }

  /**
   * Construye el prompt según el tipo de modelo y input
   */
  private buildPrompt(modelId: string, input: any): string {
    // Para resúmenes cortos (bart-large-cnn)
    if (modelId === '@cf/facebook/bart-large-cnn') {
      return `Summarize the following text in a concise way:\n\n${input.input_text || input.text || ''}`;
    }

    // Para resúmenes largos y composición de emails (llama-4-scout)
    if (modelId === '@cf/meta/llama-4-scout-17b-16e-instruct') {
      if (input.messages && Array.isArray(input.messages)) {
        // Construir el prompt completo con todos los mensajes del historial
        const promptParts: string[] = [];
        
        // Buscar el system prompt
        const systemMessage = input.messages.find((m: any) => m.role === 'system');
        if (systemMessage) {
          promptParts.push(`System: ${systemMessage.content}`);
        }
        
        // Agregar todos los mensajes del historial
        const conversationMessages = input.messages.filter((m: any) => m.role !== 'system');
        for (const msg of conversationMessages) {
          const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : msg.role;
          promptParts.push(`${roleLabel}: ${msg.content}`);
        }
        
        return promptParts.join('\n\n');
      }
      return input.input_text || input.text || '';
    }

    // Para embeddings
    if (modelId === '@cf/baai/bge-large-en-v1.5') {
      return input.text || '';
    }

    // Por defecto, intentar extraer el texto del input
    return input.input_text || input.text || JSON.stringify(input);
  }

  /**
   * Adapta la respuesta de Flowise al formato esperado por Cloudflare Workers AI
   */
  private adaptResponse(modelId: string, flowiseResponse: any): any {
    // Para resúmenes cortos (bart-large-cnn)
    if (modelId === '@cf/facebook/bart-large-cnn') {
      return {
        summary: flowiseResponse.text || flowiseResponse.data?.text || flowiseResponse.response || '',
      };
    }

    // Para embeddings (bge-large-en-v1.5)
    if (modelId === '@cf/baai/bge-large-en-v1.5') {
      // Flowise debería devolver el embedding en el formato correcto
      // Adaptar según la estructura real de la respuesta
      const embedding = flowiseResponse.data?.embedding || flowiseResponse.embedding || flowiseResponse.data;
      return {
        data: Array.isArray(embedding) ? embedding : [embedding],
      };
    }

    // Para modelos de chat/resumen (llama-4-scout, etc.)
    // Estos siempre deben devolver { response: string }
    const textResponse = flowiseResponse.text || flowiseResponse.data?.text || flowiseResponse.response || '';
    return {
      response: typeof textResponse === 'string' ? textResponse : String(textResponse),
    };
  }

  /**
   * Ejecuta un modelo de Flowise (reemplaza env.AI.run())
   * @param modelId - ID del modelo de Cloudflare (se mapea internamente a endpoint de Flowise)
   * @param input - Input para el modelo
   * @param options - Opciones adicionales (ignoradas por ahora)
   */
  async run(modelId: string, input: any, options?: any): Promise<any> {
    try {
      const endpoint = this.getEndpointForModel(modelId);
      const prompt = this.buildPrompt(modelId, input);

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
        console.error(`[FLOWISE] Error calling Flowise API: ${response.status} - ${errorText}`);
        throw new Error(`Flowise API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return this.adaptResponse(modelId, data);
    } catch (error) {
      console.error(`[FLOWISE] Error in run() for model ${modelId}:`, error);
      throw error;
    }
  }

  /**
   * Implementa compatibilidad con env.AI.autorag() para RAG
   * @param ragId - ID del RAG (no usado, ya que Flowise maneja esto internamente)
   */
  autorag(ragId?: string) {
    return {
      aiSearch: async (params: {
        query: string;
        max_num_results?: number;
        ranking_options?: {
          score_threshold?: number;
        };
        filters?: {
          type: string;
          key: string;
          value: string;
        };
      }): Promise<{ response: string; data: any[] }> => {
        try {
          const endpoint = this.ragEndpoint;

          // Construir el prompt para RAG
          const prompt = `Search and answer the following question: ${params.query}`;

          const response = await fetch(`${this.baseURL}/api/v1/prediction/${endpoint}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }),
            },
            body: JSON.stringify({
              question: prompt,
              overrideConfig: {
                sessionId: undefined,
              },
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(`[FLOWISE] Error calling RAG API: ${response.status} - ${errorText}`);
            throw new Error(`Flowise RAG API error: ${response.status} - ${errorText}`);
          }

          const data = await response.json() as any;
          
          // Adaptar respuesta al formato esperado
          return {
            response: data.text || data.data?.text || '',
            data: data.data?.results || data.results || [],
          };
        } catch (error) {
          console.error(`[FLOWISE] Error in autorag.aiSearch():`, error);
          throw error;
        }
      },
    };
  }
}

// Singleton instance
let flowiseServiceInstance: FlowiseService | null = null;

/**
 * Obtiene la instancia singleton de FlowiseService
 */
export function getFlowiseService(): FlowiseService {
  if (!flowiseServiceInstance) {
    flowiseServiceInstance = new FlowiseService();
  }
  return flowiseServiceInstance;
}

