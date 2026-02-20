import {
  createClient,
  ClientEvent,
  RoomEvent,
  EventType,
  MsgType,
} from 'matrix-js-sdk';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';

import {
  MATRIX_HOMESERVER_URL,
  MATRIX_ACCESS_TOKEN,
  MATRIX_BOT_USER_ID,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const ROOM_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client!: MatrixClient;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  private opts: MatrixChannelOpts;

  constructor(opts: MatrixChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!MATRIX_HOMESERVER_URL) {
      throw new Error('MATRIX_HOMESERVER_URL is required');
    }
    if (!MATRIX_ACCESS_TOKEN) {
      throw new Error('MATRIX_ACCESS_TOKEN is required');
    }
    if (!MATRIX_BOT_USER_ID) {
      throw new Error('MATRIX_BOT_USER_ID is required');
    }

    this.client = createClient({
      baseUrl: MATRIX_HOMESERVER_URL,
      accessToken: MATRIX_ACCESS_TOKEN,
      userId: MATRIX_BOT_USER_ID,
    });

    return new Promise<void>((resolve) => {
      let resolved = false;

      this.client.on(ClientEvent.Sync, (state: string) => {
        if (state === 'PREPARED' || state === 'SYNCING') {
          const wasDisconnected = !this.connected;
          this.connected = true;
          logger.info('Connected to Matrix');

          if (wasDisconnected) {
            this.flushOutgoingQueue().catch((err) =>
              logger.error({ err }, 'Failed to flush outgoing queue'),
            );
            this.syncRoomMetadata().catch((err) =>
              logger.error({ err }, 'Initial room metadata sync failed'),
            );
          }

          if (!resolved) {
            resolved = true;
            resolve();
          }
        } else if (state === 'ERROR') {
          this.connected = false;
          logger.warn('Matrix sync error (SDK handles retry internally)');
        } else if (state === 'STOPPED') {
          this.connected = false;
          logger.info('Matrix sync stopped');
        }
      });

      this.client.on(
        RoomEvent.Timeline,
        (
          event: MatrixEvent,
          room: Room | undefined,
          toStartOfTimeline: boolean | undefined,
        ) => {
          this.handleTimelineEvent(event, room, toStartOfTimeline);
        },
      );

      this.client.startClient({ initialSyncLimit: 0 });
    });
  }

  private handleTimelineEvent(
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
  ): void {
    if (toStartOfTimeline) return;
    if (event.getType() !== EventType.RoomMessage) return;

    const content = event.getContent();
    if (!content.body) return;

    const msgtype = content.msgtype as string;
    if (msgtype !== 'm.text' && msgtype !== 'm.notice' && msgtype !== 'm.emote')
      return;

    const roomId = event.getRoomId();
    if (!roomId || !room) return;

    const isGroup = room.getJoinedMemberCount() > 2;
    const roomName = room.name || undefined;
    const timestamp = new Date(event.getTs()).toISOString();

    this.opts.onChatMetadata(roomId, timestamp, roomName, 'matrix', isGroup);

    const groups = this.opts.registeredGroups();
    if (!groups[roomId]) return;

    const sender = event.getSender() || '';
    const member = room.getMember(sender);
    const senderName = member?.name || sender.replace(/^@/, '').split(':')[0];

    const isBotMessage = sender === MATRIX_BOT_USER_ID;
    const body = msgtype === 'm.emote' ? `* ${content.body}` : content.body;

    this.opts.onMessage(roomId, {
      id: event.getId() || '',
      chat_jid: roomId,
      sender,
      sender_name: senderName,
      content: body,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Matrix disconnected, message queued',
      );
      return;
    }
    try {
      await this.client.sendEvent(jid, EventType.RoomMessage, {
        body: text,
        msgtype: MsgType.Text,
      });
      logger.info({ jid, length: text.length }, 'Message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('!') && jid.includes(':');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client?.stopClient();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      await this.client.sendTyping(jid, isTyping, 30000);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncRoomMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < ROOM_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping room sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing room metadata from Matrix...');
      const rooms = this.client.getRooms();

      let count = 0;
      for (const room of rooms) {
        if (room.name) {
          updateChatName(room.roomId, room.name);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Room metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync room metadata');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.client.sendEvent(item.jid, EventType.RoomMessage, {
          body: item.text,
          msgtype: MsgType.Text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}
