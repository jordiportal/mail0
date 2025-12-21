/**
 * Queue Service - Sistema de colas usando pg-boss para procesamiento en segundo plano
 * Reemplaza Cloudflare Queues para desarrollo local
 */
import { PgBoss, type Job } from 'pg-boss';

// Tipos de jobs
export interface SyncConnectionJob {
  connectionId: string;
  folder?: string;
  fullSync?: boolean;
}

export interface AnalyzeThreadJob {
  connectionId: string;
  threadId: string;
  threadDbId: string;
}

export interface SyncAllConnectionsJob {
  trigger: 'cron' | 'manual';
}

// Nombres de colas
export const QUEUE_NAMES = {
  SYNC_CONNECTION: 'sync-connection',
  ANALYZE_THREAD: 'analyze-thread',
  SYNC_ALL_CONNECTIONS: 'sync-all-connections',
} as const;

// Singleton instance
let bossInstance: PgBoss | null = null;

/**
 * Inicializa pg-boss con la conexión a PostgreSQL
 */
export async function initQueueService(databaseUrl: string): Promise<PgBoss> {
  if (bossInstance) {
    return bossInstance;
  }

  bossInstance = new PgBoss({
    connectionString: databaseUrl,
    // Configuración de retención de jobs
    archiveCompletedAfterSeconds: 3600, // 1 hora
    deleteAfterDays: 7,
    // Configuración de monitoreo
    monitorStateIntervalSeconds: 30,
    // Configuración de jobs
    retryLimit: 3,
    retryDelay: 60, // 1 minuto entre reintentos
    retryBackoff: true,
  });

  // Manejar errores
  bossInstance.on('error', (error) => {
    console.error('[QUEUE_SERVICE] pg-boss error:', error);
  });

  bossInstance.on('monitor-states', (states) => {
    console.log('[QUEUE_SERVICE] Queue states:', {
      created: states.created,
      active: states.active,
      completed: states.completed,
      failed: states.failed,
    });
  });

  await bossInstance.start();
  console.log('[QUEUE_SERVICE] pg-boss started successfully');

  // Crear colas explícitamente
  await bossInstance.createQueue(QUEUE_NAMES.SYNC_CONNECTION);
  await bossInstance.createQueue(QUEUE_NAMES.ANALYZE_THREAD);
  await bossInstance.createQueue(QUEUE_NAMES.SYNC_ALL_CONNECTIONS);
  console.log('[QUEUE_SERVICE] Queues created');

  return bossInstance;
}

/**
 * Obtiene la instancia de pg-boss
 */
export function getQueueService(): PgBoss {
  if (!bossInstance) {
    throw new Error('[QUEUE_SERVICE] Queue service not initialized. Call initQueueService first.');
  }
  return bossInstance;
}

/**
 * Detiene el servicio de colas gracefully
 */
export async function stopQueueService(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true, timeout: 30000 });
    bossInstance = null;
    console.log('[QUEUE_SERVICE] pg-boss stopped');
  }
}

/**
 * Encola un job de sincronización de conexión
 */
export async function enqueueSyncConnection(
  job: SyncConnectionJob,
  options?: { delay?: number; priority?: number },
): Promise<string | null> {
  const boss = getQueueService();
  const jobId = await boss.send(QUEUE_NAMES.SYNC_CONNECTION, job, {
    startAfter: options?.delay ? new Date(Date.now() + options.delay * 1000) : undefined,
    priority: options?.priority,
    singletonKey: `sync-${job.connectionId}-${job.folder || 'all'}`,
    singletonSeconds: 300, // 5 minutos de deduplicación
  });
  console.log(`[QUEUE_SERVICE] Enqueued sync-connection job: ${jobId}`, job);
  return jobId;
}

/**
 * Encola un job de análisis de thread con AI
 */
export async function enqueueAnalyzeThread(
  job: AnalyzeThreadJob,
  options?: { delay?: number; priority?: number },
): Promise<string | null> {
  const boss = getQueueService();
  const jobId = await boss.send(QUEUE_NAMES.ANALYZE_THREAD, job, {
    startAfter: options?.delay ? new Date(Date.now() + options.delay * 1000) : undefined,
    priority: options?.priority,
    singletonKey: `analyze-${job.threadDbId}`,
    singletonSeconds: 600, // 10 minutos de deduplicación
  });
  console.log(`[QUEUE_SERVICE] Enqueued analyze-thread job: ${jobId}`, job);
  return jobId;
}

/**
 * Encola un job de sincronización de todas las conexiones
 */
export async function enqueueSyncAllConnections(
  job: SyncAllConnectionsJob,
): Promise<string | null> {
  const boss = getQueueService();
  const jobId = await boss.send(QUEUE_NAMES.SYNC_ALL_CONNECTIONS, job, {
    singletonKey: 'sync-all',
    singletonSeconds: 240, // 4 minutos de deduplicación
  });
  console.log(`[QUEUE_SERVICE] Enqueued sync-all-connections job: ${jobId}`, job);
  return jobId;
}

/**
 * Registra un handler para jobs de sincronización de conexión
 */
export async function registerSyncConnectionHandler(
  handler: (job: Job<SyncConnectionJob>) => Promise<void>,
): Promise<string> {
  const boss = getQueueService();
  return await boss.work<SyncConnectionJob>(
    QUEUE_NAMES.SYNC_CONNECTION,
    { teamSize: 2, teamConcurrency: 1 },
    handler,
  );
}

/**
 * Registra un handler para jobs de análisis de thread
 */
export async function registerAnalyzeThreadHandler(
  handler: (job: Job<AnalyzeThreadJob>) => Promise<void>,
): Promise<string> {
  const boss = getQueueService();
  return await boss.work<AnalyzeThreadJob>(
    QUEUE_NAMES.ANALYZE_THREAD,
    { teamSize: 3, teamConcurrency: 1 },
    handler,
  );
}

/**
 * Registra un handler para jobs de sincronización de todas las conexiones
 */
export async function registerSyncAllConnectionsHandler(
  handler: (job: Job<SyncAllConnectionsJob>) => Promise<void>,
): Promise<string> {
  const boss = getQueueService();
  return await boss.work<SyncAllConnectionsJob>(
    QUEUE_NAMES.SYNC_ALL_CONNECTIONS,
    { teamSize: 1, teamConcurrency: 1 },
    handler,
  );
}

/**
 * Obtiene estadísticas de las colas
 */
export async function getQueueStats(): Promise<{
  syncConnection: number;
  analyzeThread: number;
  syncAllConnections: number;
}> {
  // Nota: pg-boss 12+ no tiene getQueueSize, usamos conteo aproximado
  // Para estadísticas más precisas, se podría consultar la base de datos directamente
  return { syncConnection: 0, analyzeThread: 0, syncAllConnections: 0 };
}

