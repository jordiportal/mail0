/*
 * Servicio wrapper para VECTORIZE y VECTORIZE_MESSAGE que hace las operaciones opcionales
 * Si VECTORIZE no está disponible, simplemente devuelve resultados vacíos
 * en lugar de fallar, permitiendo que la aplicación funcione sin Cloudflare
 */

import { env } from '../env';

export class VectorizeService {
  /**
   * Verifica si VECTORIZE está disponible
   */
  private isAvailable(): boolean {
    try {
      // Intentar acceder a VECTORIZE para verificar si está disponible
      return !!env.VECTORIZE;
    } catch {
      return false;
    }
  }

  /**
   * Verifica si VECTORIZE_MESSAGE está disponible
   */
  private isMessageAvailable(): boolean {
    try {
      // Intentar acceder a VECTORIZE_MESSAGE para verificar si está disponible
      return !!env.VECTORIZE_MESSAGE;
    } catch {
      return false;
    }
  }

  /**
   * Obtiene vectores por IDs (reemplaza env.VECTORIZE.getByIds)
   */
  async getByIds(ids: string[]): Promise<any[]> {
    if (!this.isAvailable()) {
      console.warn('[VECTORIZE] VECTORIZE no está disponible, devolviendo array vacío');
      return [];
    }

    try {
      return await env.VECTORIZE.getByIds(ids);
    } catch (error) {
      console.warn('[VECTORIZE] Error al obtener vectores por IDs, devolviendo array vacío:', error);
      return [];
    }
  }

  /**
   * Obtiene vectores de mensajes por IDs (reemplaza env.VECTORIZE_MESSAGE.getByIds)
   */
  async getMessageByIds(ids: string[]): Promise<any[]> {
    if (!this.isMessageAvailable()) {
      console.warn('[VECTORIZE_MESSAGE] VECTORIZE_MESSAGE no está disponible, devolviendo array vacío');
      return [];
    }

    try {
      return await env.VECTORIZE_MESSAGE.getByIds(ids);
    } catch (error) {
      console.warn('[VECTORIZE_MESSAGE] Error al obtener vectores de mensajes por IDs, devolviendo array vacío:', error);
      return [];
    }
  }

  /**
   * Inserta o actualiza vectores (reemplaza env.VECTORIZE.upsert)
   */
  async upsert(vectors: any[]): Promise<void> {
    if (!this.isAvailable()) {
      console.warn('[VECTORIZE] VECTORIZE no está disponible, omitiendo upsert');
      return;
    }

    try {
      await env.VECTORIZE.upsert(vectors);
    } catch (error) {
      console.warn('[VECTORIZE] Error al hacer upsert de vectores, omitiendo:', error);
    }
  }

  /**
   * Inserta o actualiza vectores de mensajes (reemplaza env.VECTORIZE_MESSAGE.upsert)
   */
  async upsertMessages(vectors: any[]): Promise<void> {
    if (!this.isMessageAvailable()) {
      console.warn('[VECTORIZE_MESSAGE] VECTORIZE_MESSAGE no está disponible, omitiendo upsert');
      return;
    }

    try {
      await env.VECTORIZE_MESSAGE.upsert(vectors);
    } catch (error) {
      console.warn('[VECTORIZE_MESSAGE] Error al hacer upsert de vectores de mensajes, omitiendo:', error);
    }
  }

  /**
   * Busca vectores similares (reemplaza env.VECTORIZE.query)
   */
  async query(
    vector: number[],
    options?: {
      topK?: number;
      returnMetadata?: 'all' | 'none';
      filter?: Record<string, string>;
    },
  ): Promise<{ matches: Array<{ id: string; metadata?: Record<string, any>; score?: number }> }> {
    if (!this.isAvailable()) {
      console.warn('[VECTORIZE] VECTORIZE no está disponible, devolviendo resultados vacíos');
      return { matches: [] };
    }

    try {
      return await env.VECTORIZE.query(vector, options);
    } catch (error) {
      console.warn('[VECTORIZE] Error al buscar vectores, devolviendo resultados vacíos:', error);
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

