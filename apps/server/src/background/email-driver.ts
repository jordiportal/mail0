/**
 * Email Driver para el Background Service
 * Versión simplificada que funciona sin Cloudflare Workers
 */
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

export interface EmailThread {
  id: string;
  historyId: string | null;
}

export interface ThreadListResult {
  threads: EmailThread[];
  nextPageToken: string | null;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  subject?: string;
  sender?: {
    name?: string;
    email: string;
  };
  receivedOn?: string;
  body?: string;
  decodedBody?: string;
}

export interface ThreadDetails {
  messages: EmailMessage[];
  labels: { id: string; name: string }[];
}

export interface EmailLabel {
  id: string;
  name: string;
  color?: {
    backgroundColor: string;
    textColor: string;
  };
}

/**
 * Driver de Gmail para el background service
 */
export class GmailBackgroundDriver {
  private gmail;
  private oauth2Client: OAuth2Client;

  constructor(config: {
    accessToken: string;
    refreshToken: string;
  }) {
    this.oauth2Client = new OAuth2Client({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    });

    this.oauth2Client.setCredentials({
      access_token: config.accessToken,
      refresh_token: config.refreshToken,
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  /**
   * Lista threads de una carpeta
   */
  async list(params: {
    folder: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<ThreadListResult> {
    const labelId = this.folderToLabelId(params.folder);

    const response = await this.gmail.users.threads.list({
      userId: 'me',
      labelIds: labelId ? [labelId] : undefined,
      maxResults: params.maxResults || 50,
      pageToken: params.pageToken || undefined,
    });

    const threads: EmailThread[] = (response.data.threads || []).map((t) => ({
      id: t.id || '',
      historyId: t.historyId || null,
    }));

    return {
      threads,
      nextPageToken: response.data.nextPageToken || null,
    };
  }

  /**
   * Obtiene los detalles de un thread
   */
  async get(threadId: string): Promise<ThreadDetails> {
    const response = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages: EmailMessage[] = (response.data.messages || []).map((msg) => {
      const headers = msg.payload?.headers || [];
      const fromHeader = headers.find((h) => h.name?.toLowerCase() === 'from');
      const subjectHeader = headers.find((h) => h.name?.toLowerCase() === 'subject');
      const dateHeader = headers.find((h) => h.name?.toLowerCase() === 'date');

      // Parse from header
      let sender: EmailMessage['sender'] = undefined;
      if (fromHeader?.value) {
        const match = fromHeader.value.match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
        if (match) {
          sender = {
            name: match[1]?.trim(),
            email: match[2]?.trim() || fromHeader.value,
          };
        } else {
          sender = { email: fromHeader.value };
        }
      }

      // Decode body
      let body = '';
      let decodedBody = '';
      if (msg.payload?.body?.data) {
        body = msg.payload.body.data;
        decodedBody = this.decodeBase64(body);
      } else if (msg.payload?.parts) {
        const textPart = msg.payload.parts.find(
          (p) => p.mimeType === 'text/plain' || p.mimeType === 'text/html',
        );
        if (textPart?.body?.data) {
          body = textPart.body.data;
          decodedBody = this.decodeBase64(body);
        }
      }

      return {
        id: msg.id || '',
        threadId: msg.threadId || '',
        subject: subjectHeader?.value || undefined,
        sender,
        receivedOn: dateHeader?.value || undefined,
        body,
        decodedBody,
      };
    });

    // Get labels
    const labelIds = response.data.messages?.[0]?.labelIds || [];
    const labels = labelIds.map((id) => ({
      id,
      name: this.labelIdToName(id),
    }));

    return { messages, labels };
  }

  /**
   * Obtiene los labels del usuario
   */
  async getUserLabels(): Promise<EmailLabel[]> {
    const response = await this.gmail.users.labels.list({
      userId: 'me',
    });

    return (response.data.labels || []).map((lbl) => ({
      id: lbl.id || '',
      name: lbl.name || '',
      color: lbl.color
        ? {
            backgroundColor: lbl.color.backgroundColor || '#000000',
            textColor: lbl.color.textColor || '#ffffff',
          }
        : undefined,
    }));
  }

  private folderToLabelId(folder: string): string | null {
    const map: Record<string, string> = {
      inbox: 'INBOX',
      sent: 'SENT',
      drafts: 'DRAFT',
      spam: 'SPAM',
      trash: 'TRASH',
      starred: 'STARRED',
      important: 'IMPORTANT',
    };
    return map[folder.toLowerCase()] || null;
  }

  private labelIdToName(labelId: string): string {
    const map: Record<string, string> = {
      INBOX: 'Inbox',
      SENT: 'Sent',
      DRAFT: 'Drafts',
      SPAM: 'Spam',
      TRASH: 'Trash',
      STARRED: 'Starred',
      IMPORTANT: 'Important',
      UNREAD: 'Unread',
    };
    return map[labelId] || labelId;
  }

  private decodeBase64(data: string): string {
    try {
      // Gmail usa base64url encoding
      const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(base64, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
}

/**
 * Crea un driver de email basado en el proveedor
 */
export function createBackgroundDriver(
  providerId: string,
  config: { accessToken: string; refreshToken: string },
): GmailBackgroundDriver {
  if (providerId === 'google') {
    return new GmailBackgroundDriver(config);
  }
  // Por ahora solo soportamos Google
  // Microsoft se puede agregar después siguiendo el mismo patrón
  throw new Error(`Provider ${providerId} not supported in background service`);
}

