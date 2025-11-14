/*
 * Servicio PostgreSQL para almacenar y buscar embeddings localmente
 * Reemplaza Cloudflare VECTORIZE y VECTORIZE_MESSAGE
 */

import { createDb } from '../db';
import { threadEmbeddings, messageEmbeddings } from '../db/schema';
import { eq, sql, inArray, and } from 'drizzle-orm';
import type { ZeroEnv } from '../env';

export type VectorizeVector = {
  id: string;
  metadata?: Record<string, any>;
  values?: number[];
};

export class PostgreSQLVectorizeService {
  private env: ZeroEnv;

  constructor(env: ZeroEnv) {
    this.env = env;
  }

  /**
   * Obtiene vectores de threads por IDs
   */
  async getByIds(ids: string[]): Promise<any[]> {
    if (!ids || ids.length === 0) {
      return [];
    }

    try {
      const { db, conn } = createDb(this.env.HYPERDRIVE.connectionString);
      
      const results = await db
        .select({
          id: threadEmbeddings.id,
          metadata: threadEmbeddings.metadata,
          embedding: threadEmbeddings.embedding,
        })
        .from(threadEmbeddings)
        .where(inArray(threadEmbeddings.id, ids));

      await conn.end();

      return results.map((row) => ({
        id: row.id,
        metadata: row.metadata,
        values: row.embedding,
      }));
    } catch (error) {
      // Solo loguear el error si es crítico, no los datos
      console.warn('[POSTGRES_VECTORIZE] Error al obtener vectores de threads por IDs:', error instanceof Error ? error.message : 'Error desconocido');
      return [];
    }
  }

  /**
   * Obtiene vectores de mensajes por IDs
   */
  async getMessageByIds(ids: string[]): Promise<any[]> {
    if (!ids || ids.length === 0) {
      return [];
    }

    try {
      const { db, conn } = createDb(this.env.HYPERDRIVE.connectionString);
      
      const results = await db
        .select({
          id: messageEmbeddings.id,
          metadata: messageEmbeddings.metadata,
          embedding: messageEmbeddings.embedding,
        })
        .from(messageEmbeddings)
        .where(inArray(messageEmbeddings.id, ids));

      await conn.end();

      return results.map((row) => ({
        id: row.id,
        metadata: row.metadata,
        values: row.embedding,
      }));
    } catch (error) {
      // Solo loguear el error si es crítico, no los datos
      console.warn('[POSTGRES_VECTORIZE] Error al obtener vectores de mensajes por IDs:', error instanceof Error ? error.message : 'Error desconocido');
      return [];
    }
  }

  /**
   * Inserta o actualiza vectores de threads
   */
  async upsert(vectors: VectorizeVector[]): Promise<void> {
    if (!vectors || vectors.length === 0) {
      return;
    }

    try {
      const { db, conn } = createDb(this.env.HYPERDRIVE.connectionString);

      for (const vector of vectors) {
        if (!vector.id || !vector.values || !vector.metadata) {
          // No loguear vectores inválidos para evitar spam en la consola
          continue;
        }

        await db
          .insert(threadEmbeddings)
          .values({
            id: vector.id,
            embedding: vector.values,
            metadata: vector.metadata as {
              connection: string;
              thread: string;
              summary: string;
              lastMsg?: string;
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: threadEmbeddings.id,
            set: {
              embedding: vector.values,
              metadata: vector.metadata as {
                connection: string;
                thread: string;
                summary: string;
                lastMsg?: string;
              },
              updatedAt: new Date(),
            },
          });
      }

      await conn.end();
    } catch (error) {
      console.warn('[POSTGRES_VECTORIZE] Error al hacer upsert de vectores de threads:', error);
    }
  }

  /**
   * Inserta o actualiza vectores de mensajes
   */
  async upsertMessages(vectors: VectorizeVector[]): Promise<void> {
    if (!vectors || vectors.length === 0) {
      return;
    }

    try {
      const { db, conn } = createDb(this.env.HYPERDRIVE.connectionString);

      for (const vector of vectors) {
        if (!vector.id || !vector.values || !vector.metadata) {
          // No loguear vectores inválidos para evitar spam en la consola
          continue;
        }

        await db
          .insert(messageEmbeddings)
          .values({
            id: vector.id,
            embedding: vector.values,
            metadata: vector.metadata as {
              connection: string;
              thread: string;
              summary: string;
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: messageEmbeddings.id,
            set: {
              embedding: vector.values,
              metadata: vector.metadata as {
                connection: string;
                thread: string;
                summary: string;
              },
              updatedAt: new Date(),
            },
          });
      }

      await conn.end();
    } catch (error) {
      console.warn('[POSTGRES_VECTORIZE] Error al hacer upsert de vectores de mensajes:', error);
    }
  }

  /**
   * Busca vectores similares usando cosine similarity
   * Nota: Esta implementación usa una búsqueda simple por similitud de coseno
   * Para mejor rendimiento, considera usar pgvector extension
   */
  async query(
    vector: number[],
    options?: {
      topK?: number;
      returnMetadata?: 'all' | 'none';
      filter?: Record<string, string>;
    },
  ): Promise<{ matches: Array<{ id: string; metadata?: Record<string, any>; score?: number }> }> {
    const topK = options?.topK || 10;
    const returnMetadata = options?.returnMetadata || 'all';
    const filter = options?.filter || {};

    // Limitar el número máximo de resultados a calcular para evitar sobrecarga
    const maxResultsToCalculate = Math.max(topK * 10, 100); // Calcular máximo 10x el topK o 100, lo que sea mayor

    try {
      const { db, conn } = createDb(this.env.HYPERDRIVE.connectionString);

      // Construir condiciones de filtro
      const conditions = [];
      if (filter.connection) {
        conditions.push(sql`${threadEmbeddings.metadata}->>'connection' = ${filter.connection}`);
      }
      if (filter.thread) {
        conditions.push(sql`${threadEmbeddings.metadata}->>'thread' = ${filter.thread}`);
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Limitar los resultados obtenidos de la base de datos para evitar cargar todos los embeddings
      const results = await db
        .select({
          id: threadEmbeddings.id,
          metadata: threadEmbeddings.metadata,
          embedding: threadEmbeddings.embedding,
        })
        .from(threadEmbeddings)
        .where(whereClause)
        .limit(maxResultsToCalculate);

      await conn.end();

      // Calcular similitud de coseno para cada resultado
      const matches = results
        .map((row) => {
          const score = this.cosineSimilarity(vector, row.embedding);
          return {
            id: row.id,
            metadata: returnMetadata === 'all' ? row.metadata : undefined,
            score,
          };
        })
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, topK);

      return { matches };
    } catch (error) {
      // Solo loguear el error si es crítico, no los datos
      console.warn('[POSTGRES_VECTORIZE] Error al buscar vectores similares:', error instanceof Error ? error.message : 'Error desconocido');
      return { matches: [] };
    }
  }

  /**
   * Calcula la similitud de coseno entre dos vectores
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i]! * vecB[i]!;
      normA += vecA[i]! * vecA[i]!;
      normB += vecB[i]! * vecB[i]!;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }
}

// Singleton instance
let postgresVectorizeServiceInstance: PostgreSQLVectorizeService | null = null;

/**
 * Obtiene la instancia singleton de PostgreSQLVectorizeService
 */
export function getPostgreSQLVectorizeService(env: ZeroEnv): PostgreSQLVectorizeService {
  if (!postgresVectorizeServiceInstance) {
    postgresVectorizeServiceInstance = new PostgreSQLVectorizeService(env);
  }
  return postgresVectorizeServiceInstance;
}

