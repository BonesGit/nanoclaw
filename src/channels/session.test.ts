import fs from 'fs';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: '/tmp/test-groups',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- session-desktop-library mock ---

// Shared state across the mock instance — set before connect() to control behavior.
const mockState = vi.hoisted(() => ({
  registered: false,
  sessionId: null as string | null,
  nextConvo: null as Record<string, unknown> | null,
}));

const clientRef = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

const MOCK_SESSION_ID =
  '05abc123def456abc123def456abc123def456abc123def456abc123def456ab';

vi.mock('@bonesgit/session-desktop-library', () => ({
  SessionClient: class MockSessionClient {
    config: Record<string, unknown>;

    initialize = vi.fn().mockResolvedValue(undefined);
    shutdown = vi.fn().mockResolvedValue(undefined);
    isRegistered = vi.fn(() => mockState.registered);
    getSessionId = vi.fn(() => mockState.sessionId);
    createAccount = vi.fn().mockImplementation(async () => {
      mockState.registered = true;
      mockState.sessionId = MOCK_SESSION_ID;
      return MOCK_SESSION_ID;
    });
    sendMessage = vi.fn().mockResolvedValue('12345');
    getConversation = vi.fn(async () => mockState.nextConvo);
    acceptContactRequest = vi.fn().mockResolvedValue(undefined);
    downloadAttachment = vi
      .fn()
      .mockImplementation(
        async (att: Record<string, unknown>, destDir: string) => {
          const fileName = (att.fileName as string | undefined) ?? 'attachment';
          return `${destDir}/${fileName}`;
        },
      );
    // Returns an async iterator that never yields — prevents background loop from running.
    messages = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<never>(() => {}) };
      },
    });

    constructor(config: Record<string, unknown>) {
      this.config = config;
      clientRef.current = this as unknown as Record<string, unknown>;
    }
  },
}));

import { SessionChannel, SessionChannelOpts } from './session.js';

// --- Test helpers ---

const REGISTERED_CONV_ID =
  '05registered1234567890abcdef1234567890abcdef1234567890abcdef12345';
const REGISTERED_JID = `session:${REGISTERED_CONV_ID}`;

function createTestOpts(
  overrides?: Partial<SessionChannelOpts>,
): SessionChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      [REGISTERED_JID]: {
        name: 'Test Chat',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    dataPath: '/tmp/session-test',
    ...overrides,
  };
}

function createMsg(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'msg-1',
    conversationId: REGISTERED_CONV_ID,
    source:
      '05sender1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    body: 'Hello there',
    timestamp: 1704067200000,
    isOutgoing: false,
    attachments: [],
    ...overrides,
  };
}

function currentClient() {
  return clientRef.current!;
}

async function connectChannel(
  opts: SessionChannelOpts,
  channel: SessionChannel,
): Promise<void> {
  mockState.registered = true;
  mockState.sessionId = MOCK_SESSION_ID;
  await channel.connect();
}

// --- Tests ---

describe('SessionChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.registered = false;
    mockState.sessionId = null;
    mockState.nextConvo = null;
    clientRef.current = null;

    // Stub fs operations used by the attachment download path.
    vi.spyOn(fs, 'mkdirSync').mockImplementation(
      (() => undefined) as typeof fs.mkdirSync,
    );
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'renameSync').mockImplementation(
      (() => undefined) as typeof fs.renameSync,
    );
    vi.spyOn(fs, 'rmdirSync').mockImplementation(
      (() => undefined) as typeof fs.rmdirSync,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "session"', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.name).toBe('session');
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.isConnected()).toBe(false);
    });

    it('calls initialize() on connect', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      expect(currentClient().initialize).toHaveBeenCalled();
    });

    it('calls createAccount when not registered', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);

      mockState.registered = false;
      await channel.connect();

      expect(currentClient().createAccount).toHaveBeenCalledWith(
        'test mnemonic',
        'Andy',
      );
    });

    it('skips createAccount when already registered', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      expect(currentClient().createAccount).not.toHaveBeenCalled();
    });

    it('isConnected() returns true after connect with registered account', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      expect(channel.isConnected()).toBe(true);
    });

    it('passes dataPath to SessionClient config', async () => {
      const opts = createTestOpts({ dataPath: '/custom/session/data' });
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      expect((currentClient().config as Record<string, unknown>).dataPath).toBe(
        '/custom/session/data',
      );
    });

    it('calls shutdown on disconnect', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel.disconnect();

      expect(currentClient().shutdown).toHaveBeenCalled();
    });

    it('isConnected() returns false after disconnect', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect is no-op when not connected', async () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      await expect(channel.disconnect()).resolves.toBeUndefined();
    });

    it('getSessionId() returns null before connect', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.getSessionId()).toBeNull();
    });

    it('getSessionId() returns Session ID after connect', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      expect(channel.getSessionId()).toBe(MOCK_SESSION_ID);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message to registered conversation', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      mockState.nextConvo = {
        displayName: 'Alice',
        isApproved: true,
        isIncomingRequest: false,
      };
      await connectChannel(opts, channel);

      await channel._handleMessage(createMsg());

      expect(opts.onMessage).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.objectContaining({
          id: 'msg-1',
          chat_jid: REGISTERED_JID,
          sender:
            '05sender1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          content: 'Hello there',
          is_from_me: false,
        }),
      );
    });

    it('calls onChatMetadata for every incoming message', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      mockState.nextConvo = {
        displayName: 'Alice',
        isApproved: true,
        isIncomingRequest: false,
      };
      await connectChannel(opts, channel);

      await channel._handleMessage(createMsg());

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.any(String),
        'Alice',
        'session',
        false,
      );
    });

    it('skips outgoing messages entirely', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel._handleMessage(createMsg({ isOutgoing: true }));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('emits onChatMetadata but not onMessage for unregistered conversations', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      mockState.nextConvo = null;
      await connectChannel(opts, channel);

      const unregId =
        '05unregistered1234567890abcdef1234567890abcdef1234567890abcdef12';
      await channel._handleMessage(createMsg({ conversationId: unregId }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        `session:${unregId}`,
        expect.any(String),
        unregId,
        'session',
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('auto-accepts incoming contact requests', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      mockState.nextConvo = {
        displayName: 'New Contact',
        isApproved: false,
        isIncomingRequest: true,
      };
      await connectChannel(opts, channel);

      await channel._handleMessage(createMsg());

      expect(currentClient().acceptContactRequest).toHaveBeenCalledWith(
        REGISTERED_CONV_ID,
      );
    });

    it('does not call acceptContactRequest for approved contacts', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      mockState.nextConvo = {
        displayName: 'Alice',
        isApproved: true,
        isIncomingRequest: false,
      };
      await connectChannel(opts, channel);

      await channel._handleMessage(createMsg());

      expect(currentClient().acceptContactRequest).not.toHaveBeenCalled();
    });

    it('identifies group conversations (03 prefix) as isGroup=true', async () => {
      const groupId =
        '03groupabc123def456abc123def456abc123def456abc123def456abc123def45';
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          [`session:${groupId}`]: {
            name: 'My Group',
            folder: 'group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      mockState.nextConvo = {
        displayName: 'My Group',
        isApproved: true,
        isIncomingRequest: false,
      };
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel._handleMessage(createMsg({ conversationId: groupId }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        `session:${groupId}`,
        expect.any(String),
        'My Group',
        'session',
        true,
      );
    });

    it('identifies DM conversations (05 prefix) as isGroup=false', async () => {
      const opts = createTestOpts();
      mockState.nextConvo = {
        displayName: 'Alice',
        isApproved: true,
        isIncomingRequest: false,
      };
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel._handleMessage(createMsg());

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.any(String),
        'Alice',
        'session',
        false,
      );
    });

    it('converts timestamp ms to ISO string', async () => {
      const opts = createTestOpts();
      mockState.nextConvo = {
        displayName: 'Alice',
        isApproved: true,
        isIncomingRequest: false,
      };
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel._handleMessage(createMsg({ timestamp: 1704067200000 }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.objectContaining({ timestamp: '2024-01-01T00:00:00.000Z' }),
      );
    });

    it('downloads attachment and replies "File saved." when body is absent', async () => {
      const opts = createTestOpts();
      mockState.nextConvo = {
        displayName: 'Alice',
        isApproved: true,
        isIncomingRequest: false,
      };
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel._handleMessage(
        createMsg({
          body: undefined,
          attachments: [{ contentType: 'image/jpeg', fileName: 'photo.jpg' }],
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(currentClient().sendMessage).toHaveBeenCalledWith(
        REGISTERED_CONV_ID,
        'File saved.',
      );
    });

    it('downloads attachment and replies "File saved." when attachment has no fileName', async () => {
      const opts = createTestOpts();
      mockState.nextConvo = {
        displayName: 'Alice',
        isApproved: true,
        isIncomingRequest: false,
      };
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel._handleMessage(
        createMsg({
          body: undefined,
          attachments: [{ contentType: 'application/octet-stream' }],
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(currentClient().sendMessage).toHaveBeenCalledWith(
        REGISTERED_CONV_ID,
        'File saved.',
      );
    });

    it('skips messages with no body and no attachments', async () => {
      const opts = createTestOpts();
      mockState.nextConvo = {
        displayName: 'Alice',
        isApproved: true,
        isIncomingRequest: false,
      };
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel._handleMessage(
        createMsg({ body: undefined, attachments: [] }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('falls back to source Session ID as sender_name when displayName missing', async () => {
      const opts = createTestOpts();
      mockState.nextConvo = null;

      // Make the conversation registered even though getConversation returns null
      const sender =
        '05sender1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      opts.registeredGroups = vi.fn(() => ({
        [REGISTERED_JID]: {
          name: 'Test',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }));

      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel._handleMessage(createMsg({ source: sender }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.objectContaining({ sender_name: sender }),
      );
    });

    it('uses conversationId as chatName when displayName missing', async () => {
      const opts = createTestOpts();
      mockState.nextConvo = null;
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      const unregId =
        '05nochattitle1234567890abcdef1234567890abcdef1234567890abcdef1234';
      await channel._handleMessage(createMsg({ conversationId: unregId }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        `session:${unregId}`,
        expect.any(String),
        unregId,
        'session',
        false,
      );
    });

    it('continues handling message when getConversation rejects', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      (
        currentClient().getConversation as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error('DB error'));

      await expect(
        channel._handleMessage(createMsg()),
      ).resolves.toBeUndefined();
    });

    it('appends image placeholder when body and image attachment both present', async () => {
      const opts = createTestOpts();
      mockState.nextConvo = {
        displayName: 'Alice',
        isApproved: true,
        isIncomingRequest: false,
      };
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel._handleMessage(
        createMsg({
          body: 'Look at this',
          attachments: [{ contentType: 'image/jpeg', fileName: 'photo.jpg' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.objectContaining({
          content:
            'Look at this\n[Image: /workspace/group/attachments/photo.jpg]',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message with bare Session ID (strips session: prefix)', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel.sendMessage(REGISTERED_JID, 'Hello!');

      expect(currentClient().sendMessage).toHaveBeenCalledWith(
        REGISTERED_CONV_ID,
        'Hello!',
      );
    });

    it('strips session: prefix correctly', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel.sendMessage('session:05abc123', 'Hi');

      expect(currentClient().sendMessage).toHaveBeenCalledWith(
        '05abc123',
        'Hi',
      );
    });

    it('splits messages exceeding 2000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      const longText = 'x'.repeat(2500);
      await channel.sendMessage(REGISTERED_JID, longText);

      expect(currentClient().sendMessage).toHaveBeenCalledTimes(2);
      expect(currentClient().sendMessage).toHaveBeenNthCalledWith(
        1,
        REGISTERED_CONV_ID,
        'x'.repeat(2000),
      );
      expect(currentClient().sendMessage).toHaveBeenNthCalledWith(
        2,
        REGISTERED_CONV_ID,
        'x'.repeat(500),
      );
    });

    it('sends exactly one message at 2000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await channel.sendMessage(REGISTERED_JID, 'y'.repeat(2000));

      expect(currentClient().sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully without throwing', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      (
        currentClient().sendMessage as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error('Network error'));

      await expect(
        channel.sendMessage(REGISTERED_JID, 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );

      // Don't connect — client is null
      await channel.sendMessage(REGISTERED_JID, 'No client');

      // No error; clientRef is null so sendMessage on it was never called
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns session: JIDs for DMs (05 prefix)', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.ownsJid('session:05abc123def456')).toBe(true);
    });

    it('owns session: JIDs for groups (03 prefix)', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.ownsJid('session:03groupabc123')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own bare Session IDs without prefix', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.ownsJid('05abc123def456...')).toBe(false);
    });

    it('does not own arbitrary strings', () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error when isTyping is true', async () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      await expect(
        channel.setTyping(REGISTERED_JID, true),
      ).resolves.toBeUndefined();
    });

    it('resolves without error when isTyping is false', async () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      await expect(
        channel.setTyping(REGISTERED_JID, false),
      ).resolves.toBeUndefined();
    });

    it('resolves without error when not connected', async () => {
      const channel = new SessionChannel(
        'test mnemonic',
        'Andy',
        createTestOpts(),
      );
      await expect(
        channel.setTyping(REGISTERED_JID, true),
      ).resolves.toBeUndefined();
    });

    it('resolves without error when connected', async () => {
      const opts = createTestOpts();
      const channel = new SessionChannel('test mnemonic', 'Andy', opts);
      await connectChannel(opts, channel);

      await expect(
        channel.setTyping(REGISTERED_JID, true),
      ).resolves.toBeUndefined();
    });
  });
});
