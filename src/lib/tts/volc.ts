/**
 * Server-side VolcEngine V3 bidirectional WebSocket TTS client.
 *
 * Protocol reference: docs/volc/websocket.md
 *
 * Lifecycle:
 *   connect() → startSession(callbacks) → sendText() × N → finishSession()
 *                                                         → [audio chunks via callback]
 *                                                         → [onFinished callback]
 *   close()
 *
 * For barge-in, call cancelSession() instead of finishSession().
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { gunzipSync } from 'zlib';
import {
  TtsStallError,
  type TtsCapabilities,
  type TtsProvider,
  type TtsSessionCallbacks,
} from './types';

// === Constants ===

const WS_URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';

const CONNECT_TIMEOUT_MS = 3000;
const START_SESSION_TIMEOUT_MS = 3000;
const AUDIO_STALL_TIMEOUT_MS = 8000;

/** Event codes for the binary protocol */
const EVT = {
  // Uplink (client → server)
  StartConnection: 1,
  FinishConnection: 2,
  StartSession: 100,
  CancelSession: 101,
  FinishSession: 102,
  TaskRequest: 200,
  // Downlink (server → client)
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
} as const;

/** Message type high nibble values */
const MSG = {
  FullClientReq: 0x1,
  FullServerResp: 0x9,
  AudioResp: 0xb,
  Error: 0xf,
} as const;

// === Frame building ===

/**
 * Build a binary frame for connection-level events (no session ID).
 * Used for StartConnection and FinishConnection.
 */
function buildConnectionFrame(event: number): Buffer {
  const payload = Buffer.from('{}');
  const frame = Buffer.alloc(4 + 4 + 4 + payload.length);
  frame[0] = 0x11; // v1, 4-byte header
  frame[1] = 0x14; // full-client-request (0x1), with-event (0x4)
  frame[2] = 0x10; // JSON (0x1), no compression (0x0)
  frame[3] = 0x00; // reserved
  frame.writeInt32BE(event, 4);
  frame.writeUInt32BE(payload.length, 8);
  payload.copy(frame, 12);
  return frame;
}

/**
 * Build a binary frame for session-level events (with session ID).
 * Used for StartSession, FinishSession, CancelSession, TaskRequest.
 */
function buildSessionFrame(
  event: number,
  sessionId: string,
  payload: object,
): Buffer {
  const sidBuf = Buffer.from(sessionId, 'utf-8');
  const payBuf = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + 4 + 4 + sidBuf.length + 4 + payBuf.length);
  let off = 0;
  frame[off++] = 0x11;
  frame[off++] = 0x14;
  frame[off++] = 0x10;
  frame[off++] = 0x00;
  frame.writeInt32BE(event, off);
  off += 4;
  frame.writeUInt32BE(sidBuf.length, off);
  off += 4;
  sidBuf.copy(frame, off);
  off += sidBuf.length;
  frame.writeUInt32BE(payBuf.length, off);
  off += 4;
  payBuf.copy(frame, off);
  return frame;
}

// === Frame parsing ===

interface ParsedFrame {
  msgType: number;
  event?: number;
  payload?: Buffer;
  errorCode?: number;
}

/**
 * Parse a binary response frame from VolcEngine.
 *
 * Frame layout (all integers are big-endian):
 *   [0]    protocol version (high nibble) | header size in 4-byte units (low nibble)
 *   [1]    message type (high nibble) | flags (low nibble, 0x4 = has event)
 *   [2]    serialization (high nibble, 0=raw 1=JSON) | compression (low nibble, 0=none 1=gzip)
 *   [3]    reserved
 *   [4-7]  event number (if has-event flag set)
 *   ...    id_size(4) + id_bytes  (connection_id or session_id, for non-error frames)
 *   ...    payload_size(4) + payload_bytes
 *
 * Error frames (msgType=0xF) skip the id field and have error_code(4) instead of event.
 */
function parseFrame(data: Buffer): ParsedFrame {
  if (data.length < 4) return { msgType: 0 };

  const msgType = (data[1] >> 4) & 0xf;
  const flags = data[1] & 0xf;
  const compression = data[2] & 0xf;
  const hasEvent = (flags & 0x4) !== 0;
  let off = 4;

  // Error frame: error_code(4) + payload_size(4) + payload
  if (msgType === MSG.Error) {
    if (off + 4 > data.length) return { msgType };
    const errorCode = data.readInt32BE(off);
    off += 4;
    if (off + 4 > data.length) return { msgType, errorCode };
    const paySize = data.readUInt32BE(off);
    off += 4;
    let payload = data.subarray(off, off + paySize);
    if (compression === 1) payload = gunzipSync(payload);
    return { msgType, errorCode, payload };
  }

  // Read event number
  let event: number | undefined;
  if (hasEvent && off + 4 <= data.length) {
    event = data.readInt32BE(off);
    off += 4;
  }

  // Skip ID field (connection_id or session_id): id_size(4) + id_bytes
  if (off + 4 <= data.length) {
    const idLen = data.readUInt32BE(off);
    off += 4;
    off += idLen;
  }

  // Read payload: payload_size(4) + payload_bytes
  let payload: Buffer | undefined;
  if (off + 4 <= data.length) {
    const paySize = data.readUInt32BE(off);
    off += 4;
    if (paySize > 0 && off + paySize <= data.length) {
      payload = data.subarray(off, off + paySize);
      if (compression === 1) payload = gunzipSync(payload);
    }
  }

  return { msgType, event, payload };
}

// === Client ===

interface VolcTtsConfig {
  appId: string;
  accessKey: string;
  resourceId: string;
  speaker: string;
  sampleRate: number;
  speechRate: number;
  contextTexts?: string[];
}

function readVolcConfig(): VolcTtsConfig {
  const appId = process.env.VOLC_TTS_APPID;
  const accessKey = process.env.VOLC_TTS_ACCESS_TOKEN;
  if (!appId || !accessKey) {
    throw new Error('Missing VOLC_TTS_APPID or VOLC_TTS_ACCESS_TOKEN');
  }
  return {
    appId,
    accessKey,
    resourceId: process.env.VOLC_TTS_RESOURCE_ID || 'seed-tts-2.0',
    speaker: process.env.VOLC_TTS_SPEAKER || 'zh_female_cancan_mars_bigtts',
    sampleRate: 24000,
    speechRate: Number(process.env.VOLC_TTS_SPEECH_RATE) || 0,
    contextTexts: ['Please speak in a warm, friendly, and conversational tone.'],
  };
}

export class VolcTtsProvider implements TtsProvider {
  readonly capabilities: TtsCapabilities = {
    audioFormat: 'mp3',
    sampleRate: 24000,
    supportsCancel: true,
    supportsParalinguistic: false,
  };

  private ws: WebSocket | null = null;
  private config: VolcTtsConfig;
  private sessionId: string | null = null;
  private callbacks: TtsSessionCallbacks | null = null;

  /** One-shot resolver used by connect() and startSession() */
  private resolver: {
    resolve: () => void;
    reject: (err: Error) => void;
    successEvent: number;
    failEvents: number[];
    timer?: NodeJS.Timeout;
  } | null = null;

  /** Watchdog that fires TtsStallError if no audio/finish arrives in time */
  private stallTimer: NodeJS.Timeout | null = null;

  constructor(config: VolcTtsConfig = readVolcConfig()) {
    this.config = config;
  }

  /**
   * Open a WebSocket to VolcEngine and send StartConnection.
   * Resolves when ConnectionStarted is received.
   */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL, {
        headers: {
          'X-Api-App-Key': this.config.appId,
          'X-Api-Access-Key': this.config.accessKey,
          'X-Api-Resource-Id': this.config.resourceId,
          'X-Api-Connect-Id': randomUUID(),
        },
      });

      ws.binaryType = 'nodebuffer';
      this.ws = ws;

      const timer = setTimeout(() => {
        if (this.resolver) {
          const r = this.resolver;
          this.resolver = null;
          r.reject(
            new TtsStallError(
              `VolcEngine connect timed out after ${CONNECT_TIMEOUT_MS}ms`,
            ),
          );
          try {
            ws.close();
          } catch {}
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        this.resolver = {
          resolve,
          reject,
          successEvent: EVT.ConnectionStarted,
          failEvents: [EVT.ConnectionFailed],
          timer,
        };
        ws.send(buildConnectionFrame(EVT.StartConnection));
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        // Text frames carry error messages
        if (typeof raw === 'string') {
          const err = new Error(`VolcEngine WS text error: ${raw}`);
          if (this.resolver) {
            this.resolver.reject(err);
            this.resolver = null;
          } else {
            this.callbacks?.onError(err);
          }
          return;
        }
        this.handleFrame(Buffer.from(raw as Buffer));
      });

      ws.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.resolver) {
          this.resolver.reject(error);
          this.resolver = null;
        } else {
          this.callbacks?.onError(error);
        }
      });

      ws.on('close', () => {
        this.ws = null;
        this.sessionId = null;
      });
    });
  }

  /**
   * Start a TTS session with the given callbacks.
   * Resolves when SessionStarted is received.
   * After this, call sendText() to feed text and finishSession() when done.
   */
  async startSession(callbacks: TtsSessionCallbacks): Promise<void> {
    if (!this.ws) throw new Error('Not connected');
    this.callbacks = callbacks;
    this.sessionId = randomUUID();

    // Build additions JSON string for optional params
    const additions: Record<string, unknown> = {};
    if (this.config.contextTexts?.length) {
      additions.context_texts = this.config.contextTexts;
    }

    const payload: Record<string, unknown> = {
      user: { uid: 'web-user' },
      event: EVT.StartSession,
      namespace: 'BidirectionalTTS',
      req_params: {
        speaker: this.config.speaker,
        audio_params: {
          format: 'mp3',
          sample_rate: this.config.sampleRate,
          speech_rate: this.config.speechRate,
        },
        ...(Object.keys(additions).length > 0 && {
          additions: JSON.stringify(additions),
        }),
      },
    };

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.resolver) {
          const r = this.resolver;
          this.resolver = null;
          r.reject(
            new TtsStallError(
              `VolcEngine startSession timed out after ${START_SESSION_TIMEOUT_MS}ms`,
            ),
          );
        }
      }, START_SESSION_TIMEOUT_MS);

      this.resolver = {
        resolve,
        reject,
        successEvent: EVT.SessionStarted,
        failEvents: [EVT.SessionFailed],
        timer,
      };
      this.ws!.send(
        buildSessionFrame(EVT.StartSession, this.sessionId!, payload),
      );
    });
  }

  private armStallWatchdog(): void {
    this.clearStallWatchdog();
    this.stallTimer = setTimeout(() => {
      const cb = this.callbacks;
      this.sessionId = null;
      this.callbacks = null;
      cb?.onError(
        new TtsStallError(
          `VolcEngine TTS stalled: no audio within ${AUDIO_STALL_TIMEOUT_MS}ms`,
        ),
      );
    }, AUDIO_STALL_TIMEOUT_MS);
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /**
   * Send a text chunk for synthesis.
   * Can be called multiple times during a session — feed LLM tokens directly.
   * VolcEngine handles sentence splitting internally.
   */
  sendText(text: string): void {
    if (!this.ws || !this.sessionId) return;
    this.ws.send(
      buildSessionFrame(EVT.TaskRequest, this.sessionId, {
        event: EVT.TaskRequest,
        req_params: { text },
      }),
    );
    this.armStallWatchdog();
  }

  /**
   * Signal that all text has been sent.
   * VolcEngine will finish synthesizing remaining text.
   * The onFinished callback fires when SessionFinished is received.
   */
  finishSession(): void {
    if (!this.ws || !this.sessionId) return;
    this.ws.send(
      buildSessionFrame(EVT.FinishSession, this.sessionId, {}),
    );
    this.armStallWatchdog();
  }

  /**
   * Cancel the current session immediately (for barge-in).
   * Stops synthesis and releases server resources.
   */
  cancelSession(): void {
    if (!this.ws || !this.sessionId) return;
    this.ws.send(
      buildSessionFrame(EVT.CancelSession, this.sessionId, {}),
    );
    this.sessionId = null;
    this.callbacks = null;
    this.clearStallWatchdog();
  }

  /**
   * Close the WebSocket connection.
   * Sends FinishConnection before closing.
   */
  close(): void {
    if (!this.ws) return;
    try {
      this.ws.send(buildConnectionFrame(EVT.FinishConnection));
    } catch {
      // Connection may already be broken
    }
    this.ws.close();
    this.ws = null;
    this.sessionId = null;
    this.callbacks = null;
    if (this.resolver?.timer) clearTimeout(this.resolver.timer);
    this.resolver = null;
    this.clearStallWatchdog();
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get hasActiveSession(): boolean {
    return this.sessionId !== null;
  }

  // === Internal ===

  private handleFrame(data: Buffer): void {
    const frame = parseFrame(data);

    // Check resolver first (for connect/startSession awaits)
    if (this.resolver) {
      if (frame.event === this.resolver.successEvent) {
        const r = this.resolver;
        this.resolver = null;
        if (r.timer) clearTimeout(r.timer);
        r.resolve();
        return;
      }
      if (
        (frame.event !== undefined &&
          this.resolver.failEvents.includes(frame.event)) ||
        frame.msgType === MSG.Error
      ) {
        const r = this.resolver;
        this.resolver = null;
        if (r.timer) clearTimeout(r.timer);
        r.reject(new Error(this.extractErrorMessage(frame)));
        return;
      }
    }

    // Audio chunk
    if (frame.event === EVT.TTSResponse && frame.payload) {
      this.clearStallWatchdog();
      this.callbacks?.onAudio(Buffer.from(frame.payload));
      return;
    }

    // Session finished normally
    if (frame.event === EVT.SessionFinished) {
      this.clearStallWatchdog();
      const cb = this.callbacks;
      this.sessionId = null;
      this.callbacks = null;
      cb?.onFinished();
      return;
    }

    // Session failed
    if (frame.event === EVT.SessionFailed) {
      this.clearStallWatchdog();
      const cb = this.callbacks;
      this.sessionId = null;
      this.callbacks = null;
      cb?.onError(new Error(this.extractErrorMessage(frame)));
      return;
    }

    // Protocol-level error
    if (frame.msgType === MSG.Error) {
      this.clearStallWatchdog();
      this.callbacks?.onError(new Error(this.extractErrorMessage(frame)));
      return;
    }

    // TTSSentenceStart / TTSSentenceEnd — informational, ignored for now
  }

  private extractErrorMessage(frame: ParsedFrame): string {
    if (frame.payload) {
      try {
        const obj = JSON.parse(frame.payload.toString());
        return obj.message || obj.error || JSON.stringify(obj);
      } catch {
        return frame.payload.toString();
      }
    }
    if (frame.errorCode) return `VolcEngine TTS error code: ${frame.errorCode}`;
    return 'Unknown VolcEngine TTS error';
  }
}
