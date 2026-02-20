import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  MATRIX_HOMESERVER_URL: 'https://matrix.example.com',
  MATRIX_ACCESS_TOKEN: 'test-access-token',
  MATRIX_BOT_USER_ID: '@bot:matrix.example.com',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  getLastGroupSync: vi.fn(() => null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
}));

// Build a fake Matrix client that's an EventEmitter with the methods we need
function createFakeClient() {
  const emitter = new EventEmitter();
  const client = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
    },
    startClient: vi.fn().mockResolvedValue(undefined),
    stopClient: vi.fn(),
    sendEvent: vi.fn().mockResolvedValue({ event_id: '$sent1' }),
    sendTyping: vi.fn().mockResolvedValue({}),
    getRooms: vi.fn().mockReturnValue([]),
    // Expose the event emitter for triggering events in tests
    _emitter: emitter,
  };
  return client;
}

let fakeClient: ReturnType<typeof createFakeClient>;

// Mock matrix-js-sdk
vi.mock('matrix-js-sdk', () => {
  return {
    createClient: vi.fn(() => fakeClient),
    ClientEvent: {
      Sync: 'sync',
    },
    RoomEvent: {
      Timeline: 'Room.timeline',
    },
    EventType: {
      RoomMessage: 'm.room.message',
    },
    MsgType: {
      Text: 'm.text',
    },
  };
});

import { MatrixChannel, MatrixChannelOpts } from './matrix.js';
import { getLastGroupSync, updateChatName, setLastGroupSync } from '../db.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<MatrixChannelOpts>,
): MatrixChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      '!registered:matrix.example.com': {
        name: 'Test Room',
        folder: 'test-room',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function triggerSync(state: string, prevState?: string | null) {
  fakeClient._emitter.emit('sync', state, prevState ?? null, {});
}

function createFakeRoom(
  roomId: string,
  name: string | null,
  joinedMemberCount: number,
) {
  return {
    roomId,
    name,
    getJoinedMemberCount: () => joinedMemberCount,
    getMember: (userId: string) => {
      if (userId === '@alice:matrix.example.com') {
        return { name: 'Alice', rawDisplayName: 'Alice' };
      }
      return null;
    },
  };
}

function createFakeEvent(overrides: {
  id?: string;
  type?: string;
  sender?: string;
  roomId?: string;
  content?: Record<string, unknown>;
  ts?: number;
}) {
  return {
    getId: () => overrides.id ?? '$event1',
    getType: () => overrides.type ?? 'm.room.message',
    getSender: () => overrides.sender ?? '@alice:matrix.example.com',
    getRoomId: () => overrides.roomId ?? '!registered:matrix.example.com',
    getTs: () => overrides.ts ?? Date.now(),
    getContent: () => overrides.content ?? { body: 'Hello', msgtype: 'm.text' },
  };
}

async function triggerTimelineEvent(
  event: ReturnType<typeof createFakeEvent>,
  room: ReturnType<typeof createFakeRoom>,
  toStartOfTimeline = false,
) {
  fakeClient._emitter.emit('Room.timeline', event, room, toStartOfTimeline);
  await new Promise((r) => setTimeout(r, 0));
}

// --- Tests ---

describe('MatrixChannel', () => {
  beforeEach(() => {
    fakeClient = createFakeClient();
    vi.mocked(getLastGroupSync).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: start connect, trigger PREPARED sync state to resolve the promise.
   */
  async function connectChannel(channel: MatrixChannel): Promise<void> {
    const p = channel.connect();
    await new Promise((r) => setTimeout(r, 0));
    triggerSync('PREPARED');
    return p;
  }

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when sync reaches PREPARED', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);
      expect(fakeClient.startClient).toHaveBeenCalledWith({
        initialSyncLimit: 0,
      });
    });

    it('resolves connect() when sync reaches SYNCING', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      const p = channel.connect();
      await new Promise((r) => setTimeout(r, 0));
      triggerSync('SYNCING');
      await p;

      expect(channel.isConnected()).toBe(true);
    });

    it('sets disconnected on sync ERROR', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);

      triggerSync('ERROR');

      expect(channel.isConnected()).toBe(false);
    });

    it('sets disconnected on sync STOPPED', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);

      triggerSync('STOPPED');

      expect(channel.isConnected()).toBe(false);
    });

    it('flushes outgoing queue on reconnect', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      // Disconnect
      triggerSync('ERROR');
      expect(channel.isConnected()).toBe(false);

      // Queue a message while disconnected
      await channel.sendMessage('!room:server', 'Queued message');
      expect(fakeClient.sendEvent).not.toHaveBeenCalled();

      // Reconnect
      triggerSync('SYNCING');

      // Wait for async flush
      await new Promise((r) => setTimeout(r, 50));

      expect(fakeClient.sendEvent).toHaveBeenCalledWith(
        '!room:server',
        'm.room.message',
        { body: 'Queued message', msgtype: 'm.text' },
      );
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(fakeClient.stopClient).toHaveBeenCalled();
    });
  });

  // --- Authentication ---

  describe('authentication', () => {
    it('throws on missing MATRIX_HOMESERVER_URL', async () => {
      // Temporarily override the config mock
      const configModule = await import('../config.js');
      const originalUrl = configModule.MATRIX_HOMESERVER_URL;
      Object.defineProperty(configModule, 'MATRIX_HOMESERVER_URL', {
        value: '',
        writable: true,
      });

      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await expect(channel.connect()).rejects.toThrow('MATRIX_HOMESERVER_URL');

      Object.defineProperty(configModule, 'MATRIX_HOMESERVER_URL', {
        value: originalUrl,
        writable: true,
      });
    });

    it('throws on missing MATRIX_ACCESS_TOKEN', async () => {
      const configModule = await import('../config.js');
      const originalToken = configModule.MATRIX_ACCESS_TOKEN;
      Object.defineProperty(configModule, 'MATRIX_ACCESS_TOKEN', {
        value: '',
        writable: true,
      });

      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await expect(channel.connect()).rejects.toThrow('MATRIX_ACCESS_TOKEN');

      Object.defineProperty(configModule, 'MATRIX_ACCESS_TOKEN', {
        value: originalToken,
        writable: true,
      });
    });

    it('throws on missing MATRIX_BOT_USER_ID', async () => {
      const configModule = await import('../config.js');
      const originalUserId = configModule.MATRIX_BOT_USER_ID;
      Object.defineProperty(configModule, 'MATRIX_BOT_USER_ID', {
        value: '',
        writable: true,
      });

      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await expect(channel.connect()).rejects.toThrow('MATRIX_BOT_USER_ID');

      Object.defineProperty(configModule, 'MATRIX_BOT_USER_ID', {
        value: originalUserId,
        writable: true,
      });
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered room', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!registered:matrix.example.com',
        'Test Room',
        3,
      );
      const event = createFakeEvent({
        id: '$msg1',
        sender: '@alice:matrix.example.com',
        roomId: '!registered:matrix.example.com',
        content: { body: 'Hello Andy', msgtype: 'm.text' },
      });

      await triggerTimelineEvent(event, room);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '!registered:matrix.example.com',
        expect.any(String),
        'Test Room',
        'matrix',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        '!registered:matrix.example.com',
        expect.objectContaining({
          id: '$msg1',
          content: 'Hello Andy',
          sender_name: 'Alice',
          is_bot_message: false,
        }),
      );
    });

    it('only emits metadata for unregistered rooms', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!unregistered:matrix.example.com',
        'Other Room',
        3,
      );
      const event = createFakeEvent({
        id: '$msg2',
        sender: '@bob:matrix.example.com',
        roomId: '!unregistered:matrix.example.com',
        content: { body: 'Hello', msgtype: 'm.text' },
      });

      await triggerTimelineEvent(event, room);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '!unregistered:matrix.example.com',
        expect.any(String),
        'Other Room',
        'matrix',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores non-message events', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!registered:matrix.example.com',
        'Test Room',
        3,
      );
      const event = createFakeEvent({
        type: 'm.room.member',
        content: { membership: 'join' },
      });

      await triggerTimelineEvent(event, room);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores events with no body', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!registered:matrix.example.com',
        'Test Room',
        3,
      );
      const event = createFakeEvent({
        content: { msgtype: 'm.image', url: 'mxc://example.com/abc' },
      });

      await triggerTimelineEvent(event, room);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores historical events (toStartOfTimeline)', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!registered:matrix.example.com',
        'Test Room',
        3,
      );
      const event = createFakeEvent({
        content: { body: 'Old message', msgtype: 'm.text' },
      });

      await triggerTimelineEvent(event, room, true);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('formats m.emote with asterisk prefix', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!registered:matrix.example.com',
        'Test Room',
        3,
      );
      const event = createFakeEvent({
        sender: '@alice:matrix.example.com',
        content: { body: 'waves hello', msgtype: 'm.emote' },
      });

      await triggerTimelineEvent(event, room);

      expect(opts.onMessage).toHaveBeenCalledWith(
        '!registered:matrix.example.com',
        expect.objectContaining({
          content: '* waves hello',
        }),
      );
    });

    it('accepts m.notice messages', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!registered:matrix.example.com',
        'Test Room',
        3,
      );
      const event = createFakeEvent({
        content: { body: 'A notice', msgtype: 'm.notice' },
      });

      await triggerTimelineEvent(event, room);

      expect(opts.onMessage).toHaveBeenCalledWith(
        '!registered:matrix.example.com',
        expect.objectContaining({
          content: 'A notice',
        }),
      );
    });

    it('ignores unsupported msgtypes', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!registered:matrix.example.com',
        'Test Room',
        3,
      );
      const event = createFakeEvent({
        content: {
          body: 'image.png',
          msgtype: 'm.image',
          url: 'mxc://example.com/abc',
        },
      });

      await triggerTimelineEvent(event, room);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses localpart as sender name fallback when member not found', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!registered:matrix.example.com',
        'Test Room',
        3,
      );
      // Use a sender that the mock getMember returns null for
      const event = createFakeEvent({
        sender: '@unknown:matrix.example.com',
        content: { body: 'No display name', msgtype: 'm.text' },
      });

      await triggerTimelineEvent(event, room);

      expect(opts.onMessage).toHaveBeenCalledWith(
        '!registered:matrix.example.com',
        expect.objectContaining({
          sender_name: 'unknown',
        }),
      );
    });

    it('detects bot messages by sender matching MATRIX_BOT_USER_ID', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      const room = createFakeRoom(
        '!registered:matrix.example.com',
        'Test Room',
        3,
      );
      const event = createFakeEvent({
        sender: '@bot:matrix.example.com',
        content: { body: 'Bot response', msgtype: 'm.text' },
      });

      await triggerTimelineEvent(event, room);

      expect(opts.onMessage).toHaveBeenCalledWith(
        '!registered:matrix.example.com',
        expect.objectContaining({
          is_bot_message: true,
          is_from_me: true,
        }),
      );
    });

    it('determines isGroup from member count > 2', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      // DM room (2 members)
      const dmRoom = createFakeRoom('!registered:matrix.example.com', 'DM', 2);
      const event = createFakeEvent({
        content: { body: 'Hello', msgtype: 'm.text' },
      });

      await triggerTimelineEvent(event, dmRoom);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '!registered:matrix.example.com',
        expect.any(String),
        'DM',
        'matrix',
        false,
      );
    });
  });

  // --- Outgoing message queue ---

  describe('outgoing message queue', () => {
    it('sends message directly when connected (no prefix)', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      await channel.sendMessage('!room:server', 'Hello');

      // No ASSISTANT_NAME prefix — bot has its own Matrix identity
      expect(fakeClient.sendEvent).toHaveBeenCalledWith(
        '!room:server',
        'm.room.message',
        { body: 'Hello', msgtype: 'm.text' },
      );
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      // Don't connect — channel starts disconnected
      await channel.sendMessage('!room:server', 'Queued');
      expect(fakeClient.sendEvent).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      fakeClient.sendEvent.mockRejectedValueOnce(new Error('Network error'));

      await channel.sendMessage('!room:server', 'Will fail');

      // Should not throw, message queued for retry
    });

    it('flushes multiple queued messages in order', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('!room:server', 'First');
      await channel.sendMessage('!room:server', 'Second');
      await channel.sendMessage('!room:server', 'Third');

      // Connect — flush happens automatically
      await connectChannel(channel);

      // Give the async flush time to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(fakeClient.sendEvent).toHaveBeenCalledTimes(3);
      expect(fakeClient.sendEvent).toHaveBeenNthCalledWith(
        1,
        '!room:server',
        'm.room.message',
        { body: 'First', msgtype: 'm.text' },
      );
      expect(fakeClient.sendEvent).toHaveBeenNthCalledWith(
        2,
        '!room:server',
        'm.room.message',
        { body: 'Second', msgtype: 'm.text' },
      );
      expect(fakeClient.sendEvent).toHaveBeenNthCalledWith(
        3,
        '!room:server',
        'm.room.message',
        { body: 'Third', msgtype: 'm.text' },
      );
    });
  });

  // --- Room metadata sync ---

  describe('room metadata sync', () => {
    it('syncs room metadata on connect', async () => {
      fakeClient.getRooms.mockReturnValue([
        createFakeRoom('!room1:server', 'Room One', 3),
        createFakeRoom('!room2:server', 'Room Two', 5),
      ]);

      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      // Wait for async sync to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(updateChatName).toHaveBeenCalledWith('!room1:server', 'Room One');
      expect(updateChatName).toHaveBeenCalledWith('!room2:server', 'Room Two');
      expect(setLastGroupSync).toHaveBeenCalled();
    });

    it('skips sync when synced recently', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      // Wait for connect-time sync to complete, then clear and set recent timestamp
      await new Promise((r) => setTimeout(r, 50));
      vi.mocked(updateChatName).mockClear();
      vi.mocked(getLastGroupSync).mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      fakeClient.getRooms.mockReturnValue([
        createFakeRoom('!should-not-sync:server', 'Should Not Sync', 3),
      ]);

      await channel.syncRoomMetadata();

      expect(updateChatName).not.toHaveBeenCalled();
    });

    it('forces sync regardless of cache', async () => {
      vi.mocked(getLastGroupSync).mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      fakeClient.getRooms.mockReturnValue([
        createFakeRoom('!room:server', 'Forced Room', 3),
      ]);

      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      await channel.syncRoomMetadata(true);

      expect(updateChatName).toHaveBeenCalledWith(
        '!room:server',
        'Forced Room',
      );
    });

    it('handles sync failure gracefully', async () => {
      fakeClient.getRooms.mockImplementation(() => {
        throw new Error('Rooms not ready');
      });

      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      // Should not throw
      await expect(channel.syncRoomMetadata(true)).resolves.toBeUndefined();
    });

    it('skips rooms with no name', async () => {
      fakeClient.getRooms.mockReturnValue([
        createFakeRoom('!room1:server', 'Has Name', 3),
        createFakeRoom('!room2:server', null, 3),
        createFakeRoom('!room3:server', '', 2),
      ]);

      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      // Clear any calls from the automatic sync on connect
      vi.mocked(updateChatName).mockClear();

      await channel.syncRoomMetadata(true);

      expect(updateChatName).toHaveBeenCalledTimes(1);
      expect(updateChatName).toHaveBeenCalledWith('!room1:server', 'Has Name');
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns Matrix room IDs', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('!abc123:matrix.example.com')).toBe(true);
    });

    it('owns Matrix room IDs with different servers', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('!room:another.server.org')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('dc:12345')).toBe(false);
    });

    it('does not own random strings', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });

    it('does not own strings with just exclamation mark', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('!nocolon')).toBe(false);
    });
  });

  // --- Typing indicator ---

  describe('setTyping', () => {
    it('sends typing true with timeout', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      await channel.setTyping('!room:server', true);
      expect(fakeClient.sendTyping).toHaveBeenCalledWith(
        '!room:server',
        true,
        30000,
      );
    });

    it('sends typing false', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      await channel.setTyping('!room:server', false);
      expect(fakeClient.sendTyping).toHaveBeenCalledWith(
        '!room:server',
        false,
        30000,
      );
    });

    it('handles typing failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);

      await connectChannel(channel);

      fakeClient.sendTyping.mockRejectedValueOnce(new Error('Failed'));

      // Should not throw
      await expect(
        channel.setTyping('!room:server', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "matrix"', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.name).toBe('matrix');
    });
  });
});
