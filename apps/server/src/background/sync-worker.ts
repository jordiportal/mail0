/**
 * Sync Worker - Worker para sincronizar correos de una conexión
 * Descarga todos los correos de la cuenta sin límite
 */
import type { Job } from 'pg-boss';
import type { SyncConnectionJob } from '../lib/queue-service';
import { enqueueAnalyzeThread, enqueueSyncConnection } from '../lib/queue-service';
import { createBackgroundDriver, type GmailBackgroundDriver, type ThreadDetails } from './email-driver';
import { createDb } from '../db';
import {
  connection,
  thread,
  label,
  threadLabel,
  syncState,
} from '../db/schema';
import { eq, and } from 'drizzle-orm';

// Folders a sincronizar
const FOLDERS_TO_SYNC = ['inbox', 'sent', 'spam', 'archive', 'drafts'];

// Batch size para procesamiento
const BATCH_SIZE = 50;

/**
 * Handler principal para sincronización de conexión
 */
export async function handleSyncConnection(
  job: Job<SyncConnectionJob>,
  databaseUrl: string,
): Promise<void> {
  const { connectionId, folder, fullSync } = job.data;
  const { db, conn } = createDb(databaseUrl);

  console.log(`[SYNC_WORKER] Starting sync for connection ${connectionId}`, {
    folder: folder || 'all',
    fullSync,
  });

  try {
    // Obtener conexión de la base de datos
    const foundConnection = await db.query.connection.findFirst({
      where: eq(connection.id, connectionId),
    });

    if (!foundConnection) {
      console.error(`[SYNC_WORKER] Connection ${connectionId} not found`);
      return;
    }

    if (!foundConnection.accessToken || !foundConnection.refreshToken) {
      console.error(`[SYNC_WORKER] Connection ${connectionId} missing tokens`);
      return;
    }

    // Verificar/crear estado de sincronización
    let state = await db.query.syncState.findFirst({
      where: eq(syncState.connectionId, connectionId),
    });

    if (!state) {
      const [newState] = await db
        .insert(syncState)
        .values({
          id: crypto.randomUUID(),
          connectionId,
          syncInProgress: true,
          totalThreadsSynced: 0,
        })
        .returning();
      state = newState;
    } else {
      // Marcar sincronización en progreso
      await db
        .update(syncState)
        .set({ syncInProgress: true, lastError: null, updatedAt: new Date() })
        .where(eq(syncState.connectionId, connectionId));
    }

    // Crear driver de email
    const driver = createBackgroundDriver(foundConnection.providerId, {
      accessToken: foundConnection.accessToken,
      refreshToken: foundConnection.refreshToken,
    });

    // Sincronizar labels primero
    await syncLabels(db, driver, connectionId);

    // Determinar qué folders sincronizar
    const foldersToSync = folder ? [folder] : FOLDERS_TO_SYNC;

    let totalSynced = 0;

    for (const currentFolder of foldersToSync) {
      console.log(`[SYNC_WORKER] Syncing folder: ${currentFolder}`);
      const synced = await syncFolder(db, driver, connectionId, foundConnection, currentFolder);
      totalSynced += synced;
    }

    // Actualizar estado de sincronización
    await db
      .update(syncState)
      .set({
        syncInProgress: false,
        lastSyncAt: new Date(),
        totalThreadsSynced: (state?.totalThreadsSynced || 0) + totalSynced,
        updatedAt: new Date(),
      })
      .where(eq(syncState.connectionId, connectionId));

    console.log(`[SYNC_WORKER] Sync completed for connection ${connectionId}`, {
      totalSynced,
    });
  } catch (error) {
    console.error(`[SYNC_WORKER] Error syncing connection ${connectionId}:`, error);

    // Actualizar estado con error
    await db
      .update(syncState)
      .set({
        syncInProgress: false,
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(syncState.connectionId, connectionId));

    throw error;
  } finally {
    await conn.end();
  }
}

/**
 * Sincroniza los labels de una conexión
 */
async function syncLabels(
  db: ReturnType<typeof createDb>['db'],
  driver: GmailBackgroundDriver,
  connectionId: string,
): Promise<void> {
  try {
    const labels = await driver.getUserLabels();
    console.log(`[SYNC_WORKER] Syncing ${labels.length} labels`);

    for (const lbl of labels) {
      // Convertir el color de objeto a string (background color)
      const colorStr = lbl.color?.backgroundColor || null;
      
      await db
        .insert(label)
        .values({
          id: `${connectionId}-${lbl.id}`,
          connectionId,
          name: lbl.name,
          color: colorStr,
        })
        .onConflictDoUpdate({
          target: [label.connectionId, label.name],
          set: {
            color: colorStr,
          },
        });
    }
  } catch (error) {
    console.error('[SYNC_WORKER] Error syncing labels:', error);
  }
}

/**
 * Sincroniza todos los threads de un folder
 */
async function syncFolder(
  db: ReturnType<typeof createDb>['db'],
  driver: GmailBackgroundDriver,
  connectionId: string,
  foundConnection: typeof connection.$inferSelect,
  folder: string,
): Promise<number> {
  let pageToken: string | null = null;
  let totalSynced = 0;
  let pageNumber = 0;

  do {
    pageNumber++;
    console.log(`[SYNC_WORKER] Fetching page ${pageNumber} for folder ${folder}`);

    try {
      const result = await driver.list({
        folder,
        maxResults: BATCH_SIZE,
        pageToken: pageToken || undefined,
      });

      console.log(`[SYNC_WORKER] Got ${result.threads.length} threads from page ${pageNumber}`);

      // Procesar threads en paralelo con límite de concurrencia
      const syncPromises = result.threads.map((t) =>
        syncThread(db, driver, connectionId, foundConnection, t, folder),
      );

      const results = await Promise.allSettled(syncPromises);
      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      totalSynced += successCount;

      console.log(`[SYNC_WORKER] Synced ${successCount}/${result.threads.length} threads from page ${pageNumber}`);

      pageToken = result.nextPageToken;
    } catch (error) {
      console.error(`[SYNC_WORKER] Error fetching page ${pageNumber} for folder ${folder}:`, error);
      break;
    }
  } while (pageToken);

  console.log(`[SYNC_WORKER] Completed folder ${folder}: ${totalSynced} threads synced`);
  return totalSynced;
}

/**
 * Sincroniza un thread individual
 */
async function syncThread(
  db: ReturnType<typeof createDb>['db'],
  driver: GmailBackgroundDriver,
  connectionId: string,
  foundConnection: typeof connection.$inferSelect,
  threadInfo: { id: string; historyId: string | null },
  _folder: string,
): Promise<void> {
  try {
    // Obtener detalles completos del thread
    const threadData = await driver.get(threadInfo.id);

    if (!threadData.messages || threadData.messages.length === 0) {
      return;
    }

    const latestMessage = threadData.messages[threadData.messages.length - 1];
    const threadDbId = `${connectionId}-${threadInfo.id}`;

    // Verificar si el thread ya existe
    const existingThread = await db.query.thread.findFirst({
      where: eq(thread.id, threadDbId),
    });

    const threadValues = {
      id: threadDbId,
      connectionId,
      threadId: threadInfo.id,
      providerId: foundConnection.providerId,
      latestSender: latestMessage.sender
        ? { name: latestMessage.sender.name, email: latestMessage.sender.email }
        : null,
      latestReceivedOn: latestMessage.receivedOn ? new Date(latestMessage.receivedOn) : null,
      latestSubject: latestMessage.subject || null,
      syncedAt: new Date(),
      updatedAt: new Date(),
    };

    if (existingThread) {
      // Actualizar thread existente
      await db
        .update(thread)
        .set(threadValues)
        .where(eq(thread.id, threadDbId));
    } else {
      // Crear nuevo thread
      await db.insert(thread).values({
        ...threadValues,
        createdAt: new Date(),
      });

      // Encolar análisis AI para nuevos threads
      try {
        await enqueueAnalyzeThread({
          connectionId,
          threadId: threadInfo.id,
          threadDbId,
        });
      } catch (error) {
        console.warn(`[SYNC_WORKER] Failed to enqueue AI analysis for ${threadDbId}:`, error);
      }
    }

    // Sincronizar labels del thread
    await syncThreadLabels(db, connectionId, threadDbId, threadData.labels);
  } catch (error) {
    console.error(`[SYNC_WORKER] Error syncing thread ${threadInfo.id}:`, error);
    throw error;
  }
}

/**
 * Sincroniza los labels de un thread
 */
async function syncThreadLabels(
  db: ReturnType<typeof createDb>['db'],
  connectionId: string,
  threadDbId: string,
  labels: { id: string; name: string }[],
): Promise<void> {
  try {
    // Eliminar labels existentes
    await db.delete(threadLabel).where(eq(threadLabel.threadId, threadDbId));

    // Insertar nuevos labels
    for (const lbl of labels) {
      const labelDbId = `${connectionId}-${lbl.id}`;

      // Asegurar que el label existe
      await db
        .insert(label)
        .values({
          id: labelDbId,
          connectionId,
          name: lbl.name,
          color: null,
        })
        .onConflictDoNothing();

      // Crear relación thread-label
      await db
        .insert(threadLabel)
        .values({
          id: crypto.randomUUID(),
          threadId: threadDbId,
          labelId: labelDbId,
        })
        .onConflictDoNothing();
    }
  } catch (error) {
    console.error(`[SYNC_WORKER] Error syncing labels for thread ${threadDbId}:`, error);
  }
}

/**
 * Handler para sincronizar todas las conexiones
 */
export async function handleSyncAllConnections(
  job: Job<{ trigger: 'cron' | 'manual' }>,
  databaseUrl: string,
): Promise<void> {
  const { db, conn } = createDb(databaseUrl);

  console.log(`[SYNC_WORKER] Starting sync all connections (trigger: ${job.data.trigger})`);

  try {
    // Obtener todas las conexiones activas
    const connections = await db.query.connection.findMany({
      where: and(
        // Solo conexiones con tokens válidos
      ),
    });

    console.log(`[SYNC_WORKER] Found ${connections.length} connections to sync`);

    // Encolar sincronización para cada conexión
    for (const conn of connections) {
      if (conn.accessToken && conn.refreshToken) {
        try {
          await enqueueSyncConnection({
            connectionId: conn.id,
          });
        } catch (error) {
          console.error(`[SYNC_WORKER] Failed to enqueue sync for connection ${conn.id}:`, error);
        }
      }
    }

    console.log(`[SYNC_WORKER] Enqueued sync for ${connections.length} connections`);
  } catch (error) {
    console.error('[SYNC_WORKER] Error in sync all connections:', error);
    throw error;
  } finally {
    await conn.end();
  }
}

