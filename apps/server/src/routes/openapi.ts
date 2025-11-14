/*
 * Licensed to Zero Email Inc. under one or more contributor license agreements.
 * You may not use this file except in compliance with the Apache License, Version 2.0 (the "License").
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Reuse or distribution of this file requires a license from Zero Email Inc.
 */

import { Hono } from 'hono';
import { createAuth } from '../lib/auth';
import { zodToJsonSchema } from 'zod-to-json-schema';
import z from 'zod';
import { FOLDERS } from '../lib/utils';
import { createDb } from '../db';
import { connection } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { getThread, getZeroAgent } from '../lib/server-utils';
import { composeEmail } from '../trpc/routes/ai/compose';
import { getCurrentDateContext } from '../lib/prompts';
import { getFlowiseService } from '../lib/flowise-service';
import { getVectorizeService } from '../lib/vectorize-service';
import { env } from '../env';
import type { IGetThreadsResponse } from '../lib/driver/types';

type OpenAPIContext = {
  userId: string;
  activeConnectionId?: string;
};

/**
 * Helper para obtener contexto de usuario desde headers de autenticación
 */
async function getOpenAPIContext(request: Request): Promise<OpenAPIContext | null> {
  const authBearer = request.headers.get('Authorization');
  if (!authBearer) {
    return null;
  }

  const auth = createAuth();
  const session = await auth.api.getMcpSession({ headers: request.headers });
  if (!session) {
    return null;
  }

  // Obtener conexión activa del usuario
  const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
  const _connection = await db.query.connection.findFirst({
    where: eq(connection.userId, session.userId),
  });
  
  await conn.end();

  return {
    userId: session.userId,
    activeConnectionId: _connection?.id,
  };
}

/**
 * Helper para obtener conexión activa y asegurar que existe
 */
async function ensureActiveConnection(context: OpenAPIContext): Promise<string> {
  if (!context.activeConnectionId) {
    const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
    const _connection = await db.query.connection.findFirst({
      where: eq(connection.userId, context.userId),
    });
    await conn.end();
    if (!_connection) {
      throw new Error('No active connection found');
    }
    return _connection.id;
  }
  return context.activeConnectionId;
}

export const openapiRouter = new Hono<{ Variables: { openapiContext: OpenAPIContext } }>();

// Endpoint para obtener el spec OpenAPI (sin autenticación - debe estar primero)
openapiRouter.get('/openapi.json', async (c) => {
  const spec = {
    openapi: '3.0.0',
    info: {
      title: 'Zero Email API',
      version: '1.0.0',
      description: 'Zero Email API - OpenAPI specification for email management',
    },
    servers: [
      {
        url: process.env.VITE_PUBLIC_BACKEND_URL || 'http://localhost:8787',
        description: 'Zero Email API Server',
      },
    ],
    security: [
      {
        bearerAuth: [],
      },
    ],
    paths: {
      '/api/openapi/connections': {
        get: {
          summary: 'Get all email connections',
          description: 'Get all email connections for the authenticated user',
          operationId: 'getConnections',
          tags: ['Connections'],
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      connections: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            email: { type: 'string' },
                            provider: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/connections/active': {
        get: {
          summary: 'Get active email connection',
          description: 'Get the currently active email connection',
          operationId: 'getActiveConnection',
          tags: ['Connections'],
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      email: { type: 'string' },
                      provider: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/connections/active': {
        post: {
          summary: 'Set active email connection',
          description: 'Set the active email connection by email address',
          operationId: 'setActiveConnection',
          tags: ['Connections'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodToJsonSchema(
                  z.object({
                    email: z.string(),
                  }),
                ),
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/threads': {
        post: {
          summary: 'List email threads',
          description: 'List email threads with optional filters and pagination',
          operationId: 'listThreads',
          tags: ['Threads'],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: zodToJsonSchema(
                  z.object({
                    folder: z.string().default(FOLDERS.INBOX),
                    query: z.string().optional(),
                    maxResults: z.number().optional().default(5),
                    labelIds: z.array(z.string()).optional(),
                    pageToken: z.string().optional(),
                  }),
                ),
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      threads: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            subject: { type: 'string' },
                            sender: { type: 'string' },
                            receivedOn: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/threads/{threadId}': {
        get: {
          summary: 'Get email thread details',
          description: 'Get detailed information about a specific email thread',
          operationId: 'getThread',
          tags: ['Threads'],
          parameters: [
            {
              name: 'threadId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      subject: { type: 'string' },
                      sender: { type: 'object' },
                      receivedOn: { type: 'string' },
                      content: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/threads/{threadId}/summary': {
        get: {
          summary: 'Get thread summary',
          description: 'Get the summary of a specific email thread',
          operationId: 'getThreadSummary',
          tags: ['Threads'],
          parameters: [
            {
              name: 'threadId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      summary: { type: 'string' },
                      subject: { type: 'string' },
                      sender: { type: 'object' },
                      date: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/threads/read': {
        post: {
          summary: 'Mark threads as read',
          description: 'Mark email threads as read',
          operationId: 'markThreadsRead',
          tags: ['Threads'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodToJsonSchema(
                  z.object({
                    threadIds: z.array(z.string()),
                  }),
                ),
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/threads/unread': {
        post: {
          summary: 'Mark threads as unread',
          description: 'Mark email threads as unread',
          operationId: 'markThreadsUnread',
          tags: ['Threads'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodToJsonSchema(
                  z.object({
                    threadIds: z.array(z.string()),
                  }),
                ),
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/threads/labels': {
        post: {
          summary: 'Modify thread labels',
          description: 'Add or remove labels from email threads',
          operationId: 'modifyLabels',
          tags: ['Threads'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodToJsonSchema(
                  z.object({
                    threadIds: z.array(z.string()),
                    addLabelIds: z.array(z.string()),
                    removeLabelIds: z.array(z.string()),
                  }),
                ),
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/emails/compose': {
        post: {
          summary: 'Compose email with AI',
          description: 'Compose an email using AI assistance',
          operationId: 'composeEmail',
          tags: ['Emails'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodToJsonSchema(
                  z.object({
                    prompt: z.string(),
                    emailSubject: z.string().optional(),
                    to: z.array(z.string()).optional(),
                    cc: z.array(z.string()).optional(),
                    threadMessages: z
                      .array(
                        z.object({
                          from: z.string(),
                          to: z.array(z.string()),
                          cc: z.array(z.string()).optional(),
                          subject: z.string(),
                          body: z.string(),
                        }),
                      )
                      .optional(),
                  }),
                ),
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      content: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/emails/send': {
        post: {
          summary: 'Send email',
          description: 'Send a new email',
          operationId: 'sendEmail',
          tags: ['Emails'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodToJsonSchema(
                  z.object({
                    to: z.array(
                      z.object({
                        email: z.string(),
                        name: z.string().optional(),
                      }),
                    ),
                    subject: z.string(),
                    message: z.string(),
                    cc: z
                      .array(
                        z.object({
                          email: z.string(),
                          name: z.string().optional(),
                        }),
                      )
                      .optional(),
                    bcc: z
                      .array(
                        z.object({
                          email: z.string(),
                          name: z.string().optional(),
                        }),
                      )
                      .optional(),
                    threadId: z.string().optional(),
                    draftId: z.string().optional(),
                  }),
                ),
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/labels': {
        get: {
          summary: 'Get all labels',
          description: 'Get all available labels for the user',
          operationId: 'getUserLabels',
          tags: ['Labels'],
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      labels: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            name: { type: 'string' },
                            color: { type: 'object' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/labels/{labelId}': {
        get: {
          summary: 'Get label details',
          description: 'Get details about a specific label',
          operationId: 'getLabel',
          tags: ['Labels'],
          parameters: [
            {
              name: 'labelId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/labels': {
        post: {
          summary: 'Create label',
          description: 'Create a new email label',
          operationId: 'createLabel',
          tags: ['Labels'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodToJsonSchema(
                  z.object({
                    name: z.string(),
                    backgroundColor: z.string().optional(),
                    textColor: z.string().optional(),
                  }),
                ),
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/openapi/date': {
        get: {
          summary: 'Get current date',
          description: 'Get the current date and time',
          operationId: 'getCurrentDate',
          tags: ['Utility'],
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      date: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Better Auth Session Token',
          description: 'Better Auth session token in format: better-auth-{env}.session_token={value}',
        },
      },
    },
  };

  return c.json(spec);
});

// Middleware de autenticación (solo para endpoints que no sean openapi.json)
openapiRouter.use('*', async (c, next) => {
  // Skip auth for openapi.json endpoint - let it pass through
  if (c.req.path.endsWith('/openapi.json')) {
    await next();
    return;
  }
  const context = await getOpenAPIContext(c.req.raw);
  if (!context) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  c.set('openapiContext', context);
  await next();
});

// Implementación de endpoints REST que reutilizan lógica MCP
openapiRouter.get('/connections', async (c) => {
  const context = c.get('openapiContext');
  const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
  const connections = await db.query.connection.findMany({
    where: eq(connection.userId, context.userId),
  });
  await conn.end();
  
  return c.json({
    connections: connections.map((c) => ({
      email: c.email,
      provider: c.providerId,
    })),
  });
});

openapiRouter.get('/connections/active', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  
  const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
  const _connection = await db.query.connection.findFirst({
    where: eq(connection.id, activeConnectionId),
  });
  await conn.end();
  
  if (!_connection) {
    return c.json({ error: 'No active connection' }, 404);
  }
  
  return c.json({
    email: _connection.email,
    provider: _connection.providerId,
  });
});

openapiRouter.post('/connections/active', async (c) => {
  const context = c.get('openapiContext');
  const body = await c.req.json();
  const { email } = z.object({ email: z.string() }).parse(body);
  
  const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
  const _connection = await db.query.connection.findFirst({
    where: and(eq(connection.userId, context.userId), eq(connection.email, email)),
  });
  await conn.end();
  
  if (!_connection) {
    return c.json({ error: 'Connection not found' }, 404);
  }
  
  return c.json({
    message: `Active connection set to ${_connection.email}`,
  });
});

openapiRouter.post('/threads', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const body = await c.req.json();
  const params = z.object({
    folder: z.string().default(FOLDERS.INBOX),
    query: z.string().optional(),
    maxResults: z.number().optional().default(5),
    labelIds: z.array(z.string()).optional(),
    pageToken: z.string().optional(),
  }).parse(body);
  
  const { stub: agent } = await getZeroAgent(activeConnectionId);
  const result: IGetThreadsResponse = await agent.rawListThreads({
    folder: params.folder,
    query: params.query,
    maxResults: params.maxResults,
    labelIds: params.labelIds,
    pageToken: params.pageToken,
  });
  
  const threads = await Promise.all(
    (result.threads || []).map(async (thread) => {
      const { result: loadedThread } = await getThread(activeConnectionId, thread.id);
      return {
        id: thread.id,
        subject: loadedThread.latest?.subject,
        sender: loadedThread.latest?.sender,
        receivedOn: loadedThread.latest?.receivedOn,
      };
    }),
  );
  
  return c.json({ threads });
});

openapiRouter.get('/threads/:threadId', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const threadId = c.req.param('threadId');
  
  const { result: thread } = await getThread(activeConnectionId, threadId);
  
  return c.json({
    id: threadId,
    subject: thread.latest?.subject,
    sender: thread.latest?.sender,
    receivedOn: thread.latest?.receivedOn,
    content: thread.latest?.decodedBody || thread.latest?.body || '',
  });
});

openapiRouter.get('/threads/:threadId/summary', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const threadId = c.req.param('threadId');
  
  const vectorizeService = getVectorizeService();
  const response = await vectorizeService.getByIds([threadId]);
  const { result: thread } = await getThread(activeConnectionId, threadId);
  
  if (response.length && response?.[0]?.metadata?.['summary'] && thread?.latest?.subject) {
    const result = response[0].metadata as { summary: string; connection: string };
    if (result.connection !== activeConnectionId) {
      return c.json({ error: 'No summary found for this connection' }, 404);
    }
    
    const flowiseService = getFlowiseService();
    const shortResponse = await flowiseService.run('@cf/facebook/bart-large-cnn', {
      input_text: result.summary,
    });
    
    return c.json({
      summary: shortResponse.summary as string,
      subject: thread.latest?.subject,
      sender: thread.latest?.sender,
      date: thread.latest?.receivedOn,
    });
  }
  
  return c.json({ error: 'No summary found' }, 404);
});

openapiRouter.post('/threads/read', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const body = await c.req.json();
  const { threadIds } = z.object({ threadIds: z.array(z.string()) }).parse(body);
  
  const { stub: agent } = await getZeroAgent(activeConnectionId);
  await Promise.all(
    threadIds.map((threadId) => agent.modifyThreadLabelsInDB(threadId, [], ['UNREAD'])),
  );
  
  return c.json({ message: 'Threads marked as read' });
});

openapiRouter.post('/threads/unread', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const body = await c.req.json();
  const { threadIds } = z.object({ threadIds: z.array(z.string()) }).parse(body);
  
  const { stub: agent } = await getZeroAgent(activeConnectionId);
  await Promise.all(
    threadIds.map((threadId) => agent.modifyThreadLabelsInDB(threadId, ['UNREAD'], [])),
  );
  
  return c.json({ message: 'Threads marked as unread' });
});

openapiRouter.post('/threads/labels', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const body = await c.req.json();
  const params = z.object({
    threadIds: z.array(z.string()),
    addLabelIds: z.array(z.string()),
    removeLabelIds: z.array(z.string()),
  }).parse(body);
  
  const { stub: agent } = await getZeroAgent(activeConnectionId);
  await Promise.all(
    params.threadIds.map((threadId) =>
      agent.modifyThreadLabelsInDB(threadId, params.addLabelIds, params.removeLabelIds),
    ),
  );
  
  return c.json({
    message: `Successfully modified ${params.threadIds.length} thread(s)`,
  });
});

openapiRouter.post('/emails/compose', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const body = await c.req.json();
  const params = z.object({
    prompt: z.string(),
    emailSubject: z.string().optional(),
    to: z.array(z.string()).optional(),
    cc: z.array(z.string()).optional(),
    threadMessages: z
      .array(
        z.object({
          from: z.string(),
          to: z.array(z.string()),
          cc: z.array(z.string()).optional(),
          subject: z.string(),
          body: z.string(),
        }),
      )
      .optional(),
  }).parse(body);
  
  const newBody = await composeEmail({
    prompt: params.prompt,
    emailSubject: params.emailSubject,
    to: params.to,
    cc: params.cc,
    threadMessages: params.threadMessages,
    username: 'AI Assistant',
    connectionId: activeConnectionId,
  });
  
  return c.json({ content: newBody });
});

openapiRouter.post('/emails/send', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const body = await c.req.json();
  const params = z.object({
    to: z.array(
      z.object({
        email: z.string(),
        name: z.string().optional(),
      }),
    ),
    subject: z.string(),
    message: z.string(),
    cc: z
      .array(
        z.object({
          email: z.string(),
          name: z.string().optional(),
        }),
      )
      .optional(),
    bcc: z
      .array(
        z.object({
          email: z.string(),
          name: z.string().optional(),
        }),
      )
      .optional(),
    threadId: z.string().optional(),
    draftId: z.string().optional(),
  }).parse(body);
  
  const { stub: agent } = await getZeroAgent(activeConnectionId);
  const { draftId, ...mail } = params;
  
  try {
    if (draftId) {
      await agent.sendDraft(draftId, {
        ...mail,
        attachments: [],
        headers: {},
      });
    } else {
      await agent.create({
        ...mail,
        attachments: [],
        headers: {},
      });
    }
    
    return c.json({ message: 'Email sent successfully' });
  } catch (error) {
    console.error('Error sending email:', error);
    return c.json(
      {
        error: 'Failed to send email: ' + (error instanceof Error ? error.message : String(error)),
      },
      500,
    );
  }
});

openapiRouter.get('/labels', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  
  const { stub: agent } = await getZeroAgent(activeConnectionId);
  const labels = await agent.getUserLabels();
  
  return c.json({
    labels: labels.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
    })),
  });
});

openapiRouter.get('/labels/:labelId', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const labelId = c.req.param('labelId');
  
  const { stub: agent } = await getZeroAgent(activeConnectionId);
  const label = await agent.getLabel(labelId);
  
  return c.json({
    id: label.id,
    name: label.name,
  });
});

openapiRouter.post('/labels', async (c) => {
  const context = c.get('openapiContext');
  const activeConnectionId = await ensureActiveConnection(context);
  const body = await c.req.json();
  const params = z.object({
    name: z.string(),
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
  }).parse(body);
  
  const { stub: agent } = await getZeroAgent(activeConnectionId);
  
  try {
    await agent.createLabel({
      name: params.name,
      color:
        params.backgroundColor && params.textColor
          ? {
              backgroundColor: params.backgroundColor,
              textColor: params.textColor,
            }
          : undefined,
    });
    
    return c.json({ message: 'Label has been created' });
  } catch (error) {
    console.error('Error creating label:', error);
    return c.json({ error: 'Failed to create label' }, 500);
  }
});

openapiRouter.get('/date', async (c) => {
  return c.json({ date: getCurrentDateContext() });
});

