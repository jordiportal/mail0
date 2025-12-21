/**
 * Scheduler - Programa la sincronización periódica de correos
 * Usa node-cron para ejecutar cada 5 minutos
 */
import * as cron from 'node-cron';
import { enqueueSyncAllConnections, getQueueStats } from '../lib/queue-service';

let scheduledTask: cron.ScheduledTask | null = null;

/**
 * Inicia el scheduler de sincronización
 * @param cronExpression - Expresión cron (por defecto: cada 5 minutos)
 */
export function startScheduler(cronExpression: string = '*/5 * * * *'): void {
  if (scheduledTask) {
    console.log('[SCHEDULER] Scheduler already running');
    return;
  }

  console.log(`[SCHEDULER] Starting scheduler with expression: ${cronExpression}`);

  scheduledTask = cron.schedule(cronExpression, async () => {
    console.log(`[SCHEDULER] Triggered at ${new Date().toISOString()}`);

    try {
      // Obtener estadísticas de colas antes de encolar
      const stats = await getQueueStats();
      console.log('[SCHEDULER] Current queue stats:', stats);

      // Solo encolar si no hay muchos jobs pendientes
      if (stats.syncConnection < 50) {
        await enqueueSyncAllConnections({ trigger: 'cron' });
        console.log('[SCHEDULER] Enqueued sync-all-connections job');
      } else {
        console.log('[SCHEDULER] Skipping - too many pending sync jobs:', stats.syncConnection);
      }
    } catch (error) {
      console.error('[SCHEDULER] Error in scheduled task:', error);
    }
  });

  console.log('[SCHEDULER] Scheduler started successfully');
}

/**
 * Detiene el scheduler
 */
export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log('[SCHEDULER] Scheduler stopped');
  }
}

/**
 * Verifica si el scheduler está corriendo
 */
export function isSchedulerRunning(): boolean {
  return scheduledTask !== null;
}

/**
 * Ejecuta una sincronización manual
 */
export async function triggerManualSync(): Promise<void> {
  console.log('[SCHEDULER] Manual sync triggered');
  await enqueueSyncAllConnections({ trigger: 'manual' });
}

