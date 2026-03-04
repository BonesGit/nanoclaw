import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import type {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const _env = readEnvFile([
  'SESSION_MNEMONIC',
  'SESSION_DISPLAY_NAME',
  'SESSION_DATA_PATH',
]);

export interface SessionChannelBaseOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface SessionChannelOpts extends SessionChannelBaseOpts {
  dataPath: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyValue = any;

function uniqueDestPath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let dest = path.join(dir, fileName);
  let n = 0;
  while (fs.existsSync(dest)) {
    n++;
    dest = path.join(dir, `${base}-${n}${ext}`);
  }
  return dest;
}

export class SessionChannel implements Channel {
  name = 'session';

  private client: AnyValue | null = null;
  private opts: SessionChannelOpts;
  private mnemonic: string;
  private displayName: string;

  constructor(mnemonic: string, displayName: string, opts: SessionChannelOpts) {
    this.mnemonic = mnemonic;
    this.displayName = displayName;
    this.opts = opts;
  }

  static fromEnv(baseOpts: SessionChannelBaseOpts): SessionChannel | null {
    const mnemonic =
      process.env.SESSION_MNEMONIC || _env.SESSION_MNEMONIC || '';
    if (!mnemonic) return null;
    const displayName =
      process.env.SESSION_DISPLAY_NAME ||
      _env.SESSION_DISPLAY_NAME ||
      ASSISTANT_NAME;
    const dataPath =
      process.env.SESSION_DATA_PATH ||
      _env.SESSION_DATA_PATH ||
      path.join(DATA_DIR, 'session');
    return new SessionChannel(mnemonic, displayName, { ...baseOpts, dataPath });
  }

  async connect(): Promise<void> {
    const { SessionClient } = await import('session-desktop-library');

    this.client = new SessionClient({
      dataPath: this.opts.dataPath,
      logLevel: 'warn',
    });

    await this.client.initialize();

    // First run: no account in DB yet — create one from the mnemonic.
    // Subsequent runs: account loads automatically from the encrypted DB.
    if (!this.client.isRegistered()) {
      await this.client.restoreAccount(this.mnemonic);
      await this.client.setDisplayName(this.displayName);
    }

    const sessionId = this.client.getSessionId() as string;
    logger.info({ sessionId }, 'Session channel connected');
    console.log(`\n  Session ID: ${sessionId}`);
    console.log(
      `  Share this ID so others can start a conversation with the bot\n`,
    );

    // Start the message loop in the background — connect() returns immediately.
    this._startMessageLoop().catch((err) => {
      logger.error({ err }, 'Session message loop crashed');
    });
  }

  private async _startMessageLoop(): Promise<void> {
    if (!this.client) return;
    try {
      for await (const msg of this.client.messages() as AsyncIterable<AnyValue>) {
        this._handleMessage(msg as AnyValue).catch((err) => {
          logger.error({ err }, 'Session message handler error');
        });
      }
    } catch (err) {
      logger.error({ err }, 'Session message loop error');
    }
  }

  // Exposed for testing; normally called only by _startMessageLoop.
  async _handleMessage(msg: AnyValue): Promise<void> {
    if (!this.client || msg.isOutgoing) return;

    const chatJid = `session:${msg.conversationId as string}`;
    const timestamp = new Date(msg.timestamp as number).toISOString();

    // Attempt to fetch conversation metadata and auto-accept contact requests.
    let convo: AnyValue | null = null;
    try {
      convo = await this.client.getConversation(msg.conversationId as string);
      if (convo?.isIncomingRequest) {
        await this.client.acceptContactRequest(msg.conversationId as string);
        logger.info(
          { sessionId: msg.conversationId },
          'Session: auto-accepted contact request',
        );
      }
    } catch (err) {
      logger.debug({ err }, 'Session: failed to check/accept contact request');
    }

    const isGroup = (msg.conversationId as string).startsWith('03');
    const chatName =
      (convo?.displayName as string | undefined) ??
      (msg.conversationId as string);

    // Always record chat metadata (enables discovery of unregistered conversations).
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'session', isGroup);

    // Only deliver the full message payload for registered conversations.
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid },
        'Session: message from unregistered conversation',
      );
      return;
    }

    // ── Eager attachment download ────────────────────────────────────────────
    const rawAttachments = (msg.attachments as AnyValue[] | undefined) ?? [];
    const hasBody = !!(msg.body as string | undefined)?.trim();

    interface Downloaded {
      fileName: string;
      contentType: string;
    }
    const downloaded: Downloaded[] = [];

    if (rawAttachments.length > 0) {
      const groupDir = resolveGroupFolderPath(group.folder);
      const attachmentsDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachmentsDir, { recursive: true });

      for (const att of rawAttachments) {
        try {
          const tmpDir = path.join(
            attachmentsDir,
            `.tmp-${Math.random().toString(36).slice(2)}`,
          );
          fs.mkdirSync(tmpDir, { recursive: true });
          const downloadedTmpPath = await (this.client.downloadAttachment(
            att,
            tmpDir,
          ) as Promise<string>);
          const originalName =
            (att.fileName as string | undefined) ??
            path.basename(downloadedTmpPath);
          const finalDest = uniqueDestPath(attachmentsDir, originalName);
          fs.renameSync(downloadedTmpPath, finalDest);
          fs.rmdirSync(tmpDir);
          downloaded.push({
            fileName: path.basename(finalDest),
            contentType: (att.contentType as string | undefined) ?? '',
          });
          logger.info(
            { chatJid, fileName: downloaded.at(-1)!.fileName },
            'Session: attachment saved',
          );
        } catch (err) {
          logger.error(
            { chatJid, err },
            'Session: failed to download attachment',
          );
        }
      }
    }

    // ── Attachment-only: reply and skip Claude ───────────────────────────────
    if (!hasBody && rawAttachments.length > 0) {
      const n = downloaded.length;
      const reply =
        n === 1
          ? 'File saved.'
          : n > 1
            ? `${n} files saved.`
            : 'Could not save file.';
      await this.sendMessage(chatJid, reply).catch((err) =>
        logger.error(
          { chatJid, err },
          'Session: failed to send file-saved reply',
        ),
      );
      logger.info(
        { chatJid, savedCount: n },
        'Session: attachment-only message handled',
      );
      return;
    }

    // ── Build content for Claude ─────────────────────────────────────────────
    let content: string = (msg.body as string | undefined) ?? '';

    for (const { fileName, contentType } of downloaded) {
      if (contentType.startsWith('image/')) {
        const containerPath = `/workspace/group/attachments/${fileName}`;
        content += (content ? '\n' : '') + `[Image: ${containerPath}]`;
      }
    }

    // Normalize Session @mention → trigger word so shared trigger logic fires.
    const sessionId = this.getSessionId();
    if (sessionId && content.includes(`@${sessionId}`)) {
      content = content.replace(
        new RegExp(`@${sessionId}`, 'gi'),
        `@${ASSISTANT_NAME}`,
      );
    }

    if (!content) return;

    this.opts.onMessage(chatJid, {
      id: msg.id as string,
      chat_jid: chatJid,
      sender: msg.source as string,
      sender_name:
        (convo?.displayName as string | undefined) ?? (msg.source as string),
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: msg.source }, 'Session message stored');
  }

  async sendMessage(
    jid: string,
    text: string,
    expireTimer?: number,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Session client not initialized');
      return;
    }

    const conversationId = jid.replace(/^session:/, '');

    // Session has no hard message-length limit, but splitting at 2000 chars
    // keeps individual messages readable and avoids any server-side limits.
    const MAX_LENGTH = 2000;
    const opts = expireTimer ? { expireTimer } : undefined;
    try {
      if (text.length <= MAX_LENGTH) {
        await this.client.sendMessage(conversationId, text, opts);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.client.sendMessage(
            conversationId,
            text.slice(i, i + MAX_LENGTH),
            opts,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Session message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Session message');
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    contentType: string,
    fileName?: string,
    caption?: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Session client not initialized');
      return;
    }
    const conversationId = jid.replace(/^session:/, '');
    try {
      await this.client.sendMessage(conversationId, caption ?? '', {
        attachments: [{ path: filePath, contentType, fileName }],
      });
      logger.info({ jid, filePath, contentType }, 'Session file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Session file');
    }
  }

  async sendReply(
    jid: string,
    text: string,
    quote: { id: string; author: string; text: string },
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Session client not initialized');
      return;
    }
    const conversationId = jid.replace(/^session:/, '');
    try {
      await this.client.sendMessage(conversationId, text, { quote });
      logger.info({ jid }, 'Session reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Session reply');
    }
  }

  isConnected(): boolean {
    return this.client !== null && (this.client.isRegistered() as boolean);
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('session:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.shutdown();
      this.client = null;
      logger.info('Session client stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    const conversationId = jid.replace(/^session:/, '');
    if (conversationId.startsWith('03')) return; // groups not supported
    try {
      await this.client.setTyping(conversationId, isTyping);
    } catch (err) {
      logger.debug({ jid, err }, 'Session: setTyping failed');
    }
  }

  /** Returns the bot's Session ID, or null before connect(). */
  getSessionId(): string | null {
    return (this.client?.getSessionId() as string | null | undefined) ?? null;
  }

  async restoreAccount(mnemonic: string): Promise<string> {
    if (!this.client) throw new Error('Session client not connected');
    const sessionId = (await this.client.restoreAccount(mnemonic)) as string;
    logger.info({ sessionId }, 'Session account restored');
    return sessionId;
  }

  async createGroup(name: string, memberIds: string[]): Promise<string> {
    if (!this.client) throw new Error('Session client not connected');
    return this.client.createGroup(name, memberIds) as Promise<string>;
  }

  async addGroupMembers(
    groupId: string,
    memberIds: string[],
    opts?: { withHistory?: boolean },
  ): Promise<void> {
    if (!this.client) throw new Error('Session client not connected');
    await this.client.addGroupMembers(groupId, memberIds, opts);
  }

  async removeGroupMembers(
    groupId: string,
    memberIds: string[],
    opts?: { alsoRemoveMessages?: boolean },
  ): Promise<void> {
    if (!this.client) throw new Error('Session client not connected');
    await this.client.removeGroupMembers(groupId, memberIds, opts);
  }

  async leaveGroup(groupId: string): Promise<void> {
    if (!this.client) throw new Error('Session client not connected');
    await this.client.leaveGroup(groupId);
  }

  async getConversations(): Promise<unknown[]> {
    if (!this.client) throw new Error('Session client not connected');
    return this.client.getConversations() as Promise<unknown[]>;
  }

  async getConversation(id: string): Promise<unknown> {
    if (!this.client) throw new Error('Session client not connected');
    return this.client.getConversation(id);
  }

  async getMessages(
    conversationId: string,
    opts?: { limit?: number },
  ): Promise<unknown[]> {
    if (!this.client) throw new Error('Session client not connected');
    return this.client.getMessages(conversationId, opts) as Promise<unknown[]>;
  }

  async downloadAttachment(
    attachment: { url: string; key: string; digest: string; fileName?: string },
    destDir?: string,
  ): Promise<string> {
    if (!this.client) throw new Error('Session client not connected');
    return this.client.downloadAttachment(
      attachment,
      destDir,
    ) as Promise<string>;
  }

  async blockContact(sessionId: string): Promise<void> {
    if (!this.client) throw new Error('Session client not connected');
    await this.client.blockContact(sessionId);
  }

  async unblockContact(sessionId: string): Promise<void> {
    if (!this.client) throw new Error('Session client not connected');
    await this.client.unblockContact(sessionId);
  }

  async setDisplayName(name: string): Promise<void> {
    if (!this.client) throw new Error('Session client not connected');
    await this.client.setDisplayName(name);
  }
}
