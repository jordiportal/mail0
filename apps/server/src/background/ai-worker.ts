/**
 * AI Worker - Worker para analizar threads con IA
 * Genera resúmenes, etiquetas sugeridas y vectoriza los mensajes
 */
import type { Job } from 'pg-boss';
import type { AnalyzeThreadJob } from '../lib/queue-service';
import { createBackgroundDriver, type EmailMessage } from './email-driver';
import { createDb } from '../db';
import { connection, thread, label, threadLabel } from '../db/schema';
import { eq } from 'drizzle-orm';
import { FlowiseService } from './flowise-background';

// Obtener instancia del servicio de Flowise
const flowiseService = new FlowiseService();

// Prompt para resumir threads
const SUMMARIZE_THREAD_PROMPT = `You are an AI assistant that summarizes email threads.
Provide a concise summary of the email thread, highlighting:
1. The main topic or subject
2. Key points discussed
3. Any action items or requests
4. The overall sentiment or urgency
Keep the summary to 2-3 sentences.`;

// Prompts por defecto para sugerir etiquetas
const LABEL_SUGGESTION_PROMPT = `You are an AI that helps organize emails by suggesting appropriate labels.
Analyze the email thread summary and suggest 1-3 labels from the following categories:
- Important: High priority emails requiring attention
- Personal: Personal correspondence
- Work: Work-related emails
- Finance: Financial matters, invoices, receipts
- Travel: Travel bookings, itineraries
- Shopping: Order confirmations, shipping updates
- Social: Social networks, events, invitations
- Newsletter: Newsletters, subscriptions
- Support: Customer support, tickets

Return ONLY a JSON array of label names, nothing else. Example: ["Work", "Important"]`;

/**
 * Handler principal para análisis de thread con AI
 */
export async function handleAnalyzeThread(
  job: Job<AnalyzeThreadJob>,
  databaseUrl: string,
): Promise<void> {
  const { connectionId, threadId, threadDbId } = job.data;
  const { db, conn } = createDb(databaseUrl);

  console.log(`[AI_WORKER] Starting analysis for thread ${threadId}`, {
    connectionId,
    threadDbId,
  });

  try {
    // Obtener conexión de la base de datos
    const foundConnection = await db.query.connection.findFirst({
      where: eq(connection.id, connectionId),
    });

    if (!foundConnection) {
      console.error(`[AI_WORKER] Connection ${connectionId} not found`);
      return;
    }

    if (!foundConnection.accessToken || !foundConnection.refreshToken) {
      console.error(`[AI_WORKER] Connection ${connectionId} missing tokens`);
      return;
    }

    // Verificar que el thread existe
    const existingThread = await db.query.thread.findFirst({
      where: eq(thread.id, threadDbId),
    });

    if (!existingThread) {
      console.error(`[AI_WORKER] Thread ${threadDbId} not found in database`);
      return;
    }

    // Si ya fue procesado recientemente, saltar
    if (existingThread.aiProcessedAt) {
      const hoursSinceProcessed =
        (Date.now() - existingThread.aiProcessedAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceProcessed < 24) {
        console.log(
          `[AI_WORKER] Thread ${threadDbId} was processed ${hoursSinceProcessed.toFixed(1)} hours ago, skipping`,
        );
        return;
      }
    }

    // Crear driver de email
    const driver = createBackgroundDriver(foundConnection.providerId, {
      accessToken: foundConnection.accessToken,
      refreshToken: foundConnection.refreshToken,
    });

    // Obtener detalles completos del thread
    const threadData = await driver.get(threadId);

    if (!threadData.messages || threadData.messages.length === 0) {
      console.log(`[AI_WORKER] Thread ${threadId} has no messages`);
      return;
    }

    console.log(`[AI_WORKER] Analyzing thread with ${threadData.messages.length} messages`);

    // Generar resumen del thread
    const summary = await generateThreadSummary(connectionId, threadData.messages);

    if (summary) {
      console.log(`[AI_WORKER] Generated summary for thread ${threadId}: ${summary.substring(0, 100)}...`);

      // Sugerir etiquetas basadas en el resumen
      const suggestedLabels = await suggestLabels(summary);
      console.log(`[AI_WORKER] Suggested labels for thread ${threadId}:`, suggestedLabels);

      // Aplicar etiquetas sugeridas
      if (suggestedLabels.length > 0) {
        await applyLabels(db, connectionId, threadDbId, suggestedLabels);
      }

      // Actualizar thread con resumen y timestamp de procesamiento
      await db
        .update(thread)
        .set({
          summary,
          aiProcessedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(thread.id, threadDbId));

      console.log(`[AI_WORKER] Successfully analyzed thread ${threadId}`);
    } else {
      // Marcar como procesado aunque no se haya generado resumen
      await db
        .update(thread)
        .set({
          aiProcessedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(thread.id, threadDbId));

      console.log(`[AI_WORKER] Thread ${threadId} processed but no summary generated`);
    }
  } catch (error) {
    console.error(`[AI_WORKER] Error analyzing thread ${threadId}:`, error);
    throw error;
  } finally {
    await conn.end();
  }
}

/**
 * Genera un resumen del thread usando Flowise
 */
async function generateThreadSummary(
  connectionId: string,
  messages: EmailMessage[],
): Promise<string | null> {
  try {
    if (!messages || messages.length === 0) {
      return null;
    }

    // Construir contexto del thread
    const threadContext = messages
      .map((msg, idx) => {
        const from = msg.sender?.name || msg.sender?.email || 'Unknown';
        const date = msg.receivedOn
          ? new Date(msg.receivedOn).toLocaleDateString()
          : 'Unknown date';
        const subject = msg.subject || 'No subject';
        const body = (msg.decodedBody || msg.body || '').substring(0, 500);

        return `Message ${idx + 1}:
From: ${from}
Date: ${date}
Subject: ${subject}
Content: ${body}`;
      })
      .join('\n\n---\n\n');

    const prompt = `Summarize the following email thread in 2-3 sentences. Focus on the main topic, key points, and any action items:

${threadContext}`;

    const response = await flowiseService.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
      messages: [
        {
          role: 'system',
          content: SUMMARIZE_THREAD_PROMPT,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const summary = response.response;
    return typeof summary === 'string' ? summary : null;
  } catch (error) {
    console.error('[AI_WORKER] Error generating summary:', error);
    return null;
  }
}

/**
 * Sugiere etiquetas basadas en el resumen del thread
 */
async function suggestLabels(summary: string): Promise<string[]> {
  try {
    const response = await flowiseService.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
      messages: [
        {
          role: 'system',
          content: LABEL_SUGGESTION_PROMPT,
        },
        {
          role: 'user',
          content: `Email thread summary: ${summary}`,
        },
      ],
    });

    const labelsText = response.response;
    if (typeof labelsText !== 'string') {
      return [];
    }

    // Intentar parsear como JSON
    try {
      // Extraer JSON del texto (puede tener texto adicional)
      const jsonMatch = labelsText.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        const labels = JSON.parse(jsonMatch[0]);
        if (Array.isArray(labels)) {
          return labels.filter((l) => typeof l === 'string').slice(0, 3);
        }
      }
    } catch {
      console.warn('[AI_WORKER] Failed to parse labels JSON:', labelsText);
    }

    return [];
  } catch (error) {
    console.error('[AI_WORKER] Error suggesting labels:', error);
    return [];
  }
}

/**
 * Aplica etiquetas sugeridas al thread
 */
async function applyLabels(
  db: ReturnType<typeof createDb>['db'],
  connectionId: string,
  threadDbId: string,
  suggestedLabels: string[],
): Promise<void> {
  try {
    for (const labelName of suggestedLabels) {
      const labelDbId = `${connectionId}-ai-${labelName.toLowerCase().replace(/\s+/g, '-')}`;

      // Crear label si no existe
      await db
        .insert(label)
        .values({
          id: labelDbId,
          connectionId,
          name: `AI: ${labelName}`,
          color: '#8B5CF6', // Purple para labels de AI
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

    console.log(`[AI_WORKER] Applied ${suggestedLabels.length} labels to thread ${threadDbId}`);
  } catch (error) {
    console.error(`[AI_WORKER] Error applying labels to thread ${threadDbId}:`, error);
  }
}

