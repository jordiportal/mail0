/*
 * Servicio wrapper que usa PostgreSQL para almacenar embeddings localmente
 * Reemplaza Cloudflare VECTORIZE y VECTORIZE_MESSAGE completamente
 */

import { env } from '../env';
import { getPostgreSQLVectorizeService } from './postgres-vectorize-service';

export class VectorizeService {
  private postgresService = getPostgreSQLVectorizeService(env);

  /**
   * Obtiene vectores por IDs (usa PostgreSQL)
   */
  async getByIds(ids: string[]): Promise<any[]> {
    try {
      return await this.postgresService.getByIds(ids);
    } catch (error) {
      console.warn('[VECTORIZE] Error al obtener vectores por IDs:', error);
      return [];
    }
  }

  /**
   * Obtiene vectores de mensajes por IDs (usa PostgreSQL)
   */
  async getMessageByIds(ids: string[]): Promise<any[]> {
    try {
      return await this.postgresService.getMessageByIds(ids);
    } catch (error) {
      console.warn('[VECTORIZE_MESSAGE] Error al obtener vectores de mensajes por IDs:', error);
      return [];
    }
  }

  /**
   * Inserta o actualiza vectores (usa PostgreSQL)
   */
  async upsert(vectors: any[]): Promise<void> {
    try {
      await this.postgresService.upsert(vectors);
    } catch (error) {
      console.warn('[VECTORIZE] Error al hacer upsert de vectores:', error);
    }
  }

  /**
   * Inserta o actualiza vectores de mensajes (usa PostgreSQL)
   */
  async upsertMessages(vectors: any[]): Promise<void> {
    try {
      await this.postgresService.upsertMessages(vectors);
    } catch (error) {
      console.warn('[VECTORIZE_MESSAGE] Error al hacer upsert de vectores de mensajes:', error);
    }
  }

  /**
   * Busca vectores similares (usa PostgreSQL con cosine similarity)
   */
  async query(
    vector: number[],
    options?: {
      topK?: number;
      returnMetadata?: 'all' | 'none';
      filter?: Record<string, string>;
    },
  ): Promise<{ matches: Array<{ id: string; metadata?: Record<string, any>; score?: number }> }> {
    try {
      return await this.postgresService.query(vector, options);
    } catch (error) {
      console.warn('[VECTORIZE] Error al buscar vectores similares:', error);
      return { matches: [] };
    }
  }
}

// Singleton instance
let vectorizeServiceInstance: VectorizeService | null = null;

/**
 * Obtiene la instancia singleton de VectorizeService
 */
export function getVectorizeService(): VectorizeService {
  if (!vectorizeServiceInstance) {
    vectorizeServiceInstance = new VectorizeService();
  }
  return vectorizeServiceInstance;
}

