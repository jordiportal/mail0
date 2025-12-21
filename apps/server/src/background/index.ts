/**
 * Background Service - Entrypoint principal para el servicio de sincronización en segundo plano
 * 
 * Este servicio se ejecuta independientemente del servidor principal y maneja:
 * - Sincronización periódica de correos (cada 5 minutos)
 * - Análisis de threads con AI
 * - Procesamiento de colas con pg-boss
 * 
 * Uso: pnpm background
 */
import {
  initQueueService,
  stopQueueService,
  registerSyncConnectionHandler,
  registerAnalyzeThreadHandler,
  registerSyncAllConnectionsHandler,
  getQueueStats,
} from '../lib/queue-service';
import { handleSyncConnection, handleSyncAllConnections } from './sync-worker';
import { handleAnalyzeThread } from './ai-worker';
import { startScheduler, stopScheduler } from './scheduler';

// Configuración desde variables de entorno
const DATABASE_URL = process.env.DATABASE_URL;
const SYNC_CRON = process.env.SYNC_CRON || '*/5 * * * *'; // Por defecto cada 5 minutos
const ENABLE_SCHEDULER = process.env.ENABLE_SCHEDULER !== 'false';

if (!DATABASE_URL) {
  console.error('[BACKGROUND] DATABASE_URL environment variable is required');
  process.exit(1);
}

/**
 * Inicia el servicio de background
 */
async function start(): Promise<void> {
  console.log('[BACKGROUND] Starting background service...');
  console.log('[BACKGROUND] Configuration:', {
    syncCron: SYNC_CRON,
    enableScheduler: ENABLE_SCHEDULER,
    databaseUrl: DATABASE_URL.replace(/:[^:@]+@/, ':****@'), // Ocultar password
  });

  try {
    // Inicializar pg-boss
    console.log('[BACKGROUND] Initializing queue service...');
    await initQueueService(DATABASE_URL);

    // Registrar handlers
    console.log('[BACKGROUND] Registering handlers...');
    
    await registerSyncConnectionHandler(async (job) => {
      await handleSyncConnection(job, DATABASE_URL);
    });
    console.log('[BACKGROUND] Registered sync-connection handler');

    await registerAnalyzeThreadHandler(async (job) => {
      await handleAnalyzeThread(job, DATABASE_URL);
    });
    console.log('[BACKGROUND] Registered analyze-thread handler');

    await registerSyncAllConnectionsHandler(async (job) => {
      await handleSyncAllConnections(job, DATABASE_URL);
    });
    console.log('[BACKGROUND] Registered sync-all-connections handler');

    // Iniciar scheduler si está habilitado
    if (ENABLE_SCHEDULER) {
      startScheduler(SYNC_CRON);
    } else {
      console.log('[BACKGROUND] Scheduler disabled');
    }

    // Mostrar estadísticas iniciales
    const stats = await getQueueStats();
    console.log('[BACKGROUND] Initial queue stats:', stats);

    console.log('[BACKGROUND] Background service started successfully');
    console.log('[BACKGROUND] Listening for jobs...');
  } catch (error) {
    console.error('[BACKGROUND] Failed to start background service:', error);
    process.exit(1);
  }
}

/**
 * Detiene el servicio gracefully
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[BACKGROUND] Received ${signal}, shutting down gracefully...`);

  try {
    // Detener scheduler
    stopScheduler();

    // Detener pg-boss (espera a que terminen los jobs activos)
    await stopQueueService();

    console.log('[BACKGROUND] Background service stopped');
    process.exit(0);
  } catch (error) {
    console.error('[BACKGROUND] Error during shutdown:', error);
    process.exit(1);
  }
}

// Manejar señales de terminación
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Manejar errores no capturados
process.on('uncaughtException', (error) => {
  console.error('[BACKGROUND] Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[BACKGROUND] Unhandled rejection at:', promise, 'reason:', reason);
});

// Iniciar servicio
start().catch((error) => {
  console.error('[BACKGROUND] Fatal error:', error);
  process.exit(1);
});

