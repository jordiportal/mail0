import { getActiveConnection, getZeroDB } from '../server-utils';
import { getContext } from 'hono/context-storage';
import type { gmail_v1 } from '@googleapis/gmail';
import type { HonoContext } from '../../ctx';

import { toByteArray } from 'base64-js';
export const FatalErrors = ['invalid_grant'];

export const deleteActiveConnection = async (connectionId?: string, userId?: string) => {
  try {
    let c: HonoContext | undefined;
    try {
      c = getContext<HonoContext>();
    } catch (error) {
      // Context not available - this is OK when called from workflows or background jobs
      console.log('[deleteActiveConnection] Context not available, using provided parameters');
    }

    // If we have context, try to get active connection and session
    if (c) {
      const activeConnection = await getActiveConnection();
      if (!activeConnection) {
        console.log('No connection ID found');
        return;
      }
      
      const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) {
        console.log('No session found');
        return;
      }
      
      try {
        await c.var.auth.api.signOut({ headers: c.req.raw.headers });
      } catch (signOutError) {
        console.warn('[deleteActiveConnection] Failed to sign out:', signOutError);
      }
      
      const db = await getZeroDB(session.user.id);
      await db.deleteActiveConnection(activeConnection.id);
      return;
    }

    // Fallback: use provided parameters if context is not available
    if (connectionId && userId) {
      const db = await getZeroDB(userId);
      await db.deleteActiveConnection(connectionId);
      console.log(`[deleteActiveConnection] Deleted connection ${connectionId} for user ${userId}`);
      return;
    }

    console.warn('[deleteActiveConnection] No context and no parameters provided, skipping deletion');
  } catch (error) {
    console.error('Server: Error deleting connection:', error);
    // Don't throw - this is a cleanup operation and shouldn't break the main flow
  }
};

export const fromBase64Url = (str: string) => str.replace(/-/g, '+').replace(/_/g, '/');

export const fromBinary = (str: string) =>
  new TextDecoder().decode(toByteArray(str.replace(/-/g, '+').replace(/_/g, '/')));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const findHtmlBody = (parts: any[]): string => {
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      return part.body.data;
    }
    if (part.parts) {
      const found = findHtmlBody(part.parts);
      if (found) return found;
    }
  }
  console.log('⚠️ Driver: No HTML content found in message parts');
  return '';
};

export class StandardizedError extends Error {
  code: string;
  operation: string;
  context?: Record<string, unknown>;
  originalError: unknown;
  constructor(
    error: Error & { code: string },
    operation: string,
    context?: Record<string, unknown>,
  ) {
    super(error?.message || 'An unknown error occurred');
    this.name = 'StandardizedError';
    this.code = error?.code || 'UNKNOWN_ERROR';
    this.operation = operation;
    this.context = context;
    this.originalError = error;
  }
}

export function sanitizeContext(context?: Record<string, unknown>) {
  if (!context) return undefined;
  const sanitized = { ...context };
  const sensitive = ['tokens', 'refresh_token', 'code', 'message', 'raw', 'data'];
  for (const key of sensitive) {
    if (key in sanitized) {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
}

/**
 * Retrieves the original sender address for a forwarded email from SimpleLogin
 * from the headers of a Gmail email. Header: `X-SimpleLogin-Original-From`
 */
export function getSimpleLoginSender(payload: gmail_v1.Schema$Message['payload']) {
  return payload?.headers?.find((h) => h.name === 'X-SimpleLogin-Original-From')?.value || null;
}
