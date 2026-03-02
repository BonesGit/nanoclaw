import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
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
    const mnemonic = process.env.SESSION_MNEMONIC || _env.SESSION_MNEMONIC || '';
    if (!mnemonic) return null;
    const displayName =
      process.env.SESSION_DISPLAY_NAME || _env.SESSION_DISPLAY_NAME || ASSISTANT_NAME;
    const dataPath =
      process.env.SESSION_DATA_PATH ||
      _env.SESSION_DATA_PATH ||
      path.join(DATA_DIR, 'session');
    return new SessionChannel(mnemonic, displayName, { ...baseOpts, dataPath });
  }

  async connect(): Promise<void> {
    const { SessionClient } = await import('session-desktop');

    this.client = new SessionClient({
      dataPath: this.opts.dataPath,
      logLevel: 'warn',
    });

    await this.client.initialize();

    // First run: no account in DB yet — create one from the mnemonic.
    // Subsequent runs: account loads automatically from the encrypted DB.
    if (!this.client.isRegistered()) {
      await this.client.createAccount(this.mnemonic, this.displayName);
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

    // Build a content string. Body takes priority; fall back to attachment placeholder.
    let content: string = (msg.body as string | undefined) ?? '';
    if (!content && (msg.attachments as AnyValue[] | undefined)?.length) {
      const att = (msg.attachments as AnyValue[])[0];
      content = att.fileName
        ? `[Attachment: ${att.fileName as string}]`
        : '[Attachment]';
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

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Session client not initialized');
      return;
    }

    const conversationId = jid.replace(/^session:/, '');

    // Session has no hard message-length limit, but splitting at 2000 chars
    // keeps individual messages readable and avoids any server-side limits.
    const MAX_LENGTH = 2000;
    try {
      if (text.length <= MAX_LENGTH) {
        await this.client.sendMessage(conversationId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.client.sendMessage(
            conversationId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Session message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Session message');
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

  // Session protocol does not expose a typing indicator in the headless API.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // No-op
  }

  /** Returns the bot's Session ID, or null before connect(). */
  getSessionId(): string | null {
    return (this.client?.getSessionId() as string | null | undefined) ?? null;
  }
}
