import WebSocket from "ws";
import {
  TtsStallError,
  type TtsCapabilities,
  type TtsProvider,
  type TtsSessionCallbacks,
} from "./types";

const WS_URL = "wss://api.minimaxi.com/ws/v1/t2a_v2";

const CONNECT_TIMEOUT_MS = 3000;
const START_SESSION_TIMEOUT_MS = 3000;
const AUDIO_STALL_TIMEOUT_MS = 8000;

/**
 * Characters that trigger a flush of the text buffer. Minimax synthesizes each
 * task_continue as its own prosodic unit, so feeding single tokens produces
 * drawn-out, staccato speech. Batching to clause/sentence boundaries yields
 * natural pacing while still streaming at phrase granularity.
 */
const FLUSH_CHARS = /[。！？.!?；;，,、\n]/;
const MAX_BUFFER_CHARS = 80;

interface MinimaxConfig {
  apiKey: string;
  model: string;
  voiceId: string;
  emotion?: string;
  sampleRate: number;
  languageBoost?: string;
  speed?: number;
}

function readMinimaxConfig(): MinimaxConfig {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("Missing MINIMAX_API_KEY");
  return {
    apiKey,
    model: process.env.MINIMAX_TTS_MODEL || "speech-2.8-hd",
    voiceId: process.env.MINIMAX_TTS_VOICE_ID || "male-qn-qingse",
    emotion: process.env.MINIMAX_TTS_EMOTION || undefined,
    sampleRate: Number(process.env.MINIMAX_TTS_SAMPLE_RATE) || 32000,
    languageBoost: process.env.MINIMAX_TTS_LANGUAGE_BOOST || undefined,
    speed: Number(process.env.MINIMAX_TTS_SPEED) || undefined,
  };
}

type Phase = "idle" | "handshake" | "task_start" | "active" | "finishing";

export class MinimaxTtsProvider implements TtsProvider {
  private config: MinimaxConfig;
  private ws: WebSocket | null = null;
  private phase: Phase = "idle";
  private callbacks: TtsSessionCallbacks | null = null;
  private pending: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    expect: "connected_success" | "task_started";
  } | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private textBuffer = "";

  readonly capabilities: TtsCapabilities;

  constructor(config: MinimaxConfig = readMinimaxConfig()) {
    this.config = config;
    const model = config.model;
    this.capabilities = {
      audioFormat: "mp3",
      sampleRate: config.sampleRate,
      supportsCancel: false,
      supportsParalinguistic: model.startsWith("speech-2.8"),
    };
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get hasActiveSession(): boolean {
    return this.phase === "active" || this.phase === "finishing";
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      this.ws = ws;
      this.phase = "handshake";

      const timer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          try {
            ws.close();
          } catch {}
          reject(
            new TtsStallError(
              `Minimax connect timed out after ${CONNECT_TIMEOUT_MS}ms`,
            ),
          );
        }
      }, CONNECT_TIMEOUT_MS);

      this.pending = { resolve, reject, timer, expect: "connected_success" };

      ws.on("message", (raw) => this.handleMessage(raw));
      ws.on("error", (err) => this.fail(err as Error));
      ws.on("close", () => {
        this.ws = null;
        if (this.phase !== "idle") {
          this.fail(new Error("Minimax WebSocket closed unexpectedly"));
        }
        this.phase = "idle";
      });
    });
  }

  async startSession(callbacks: TtsSessionCallbacks): Promise<void> {
    if (!this.ws || this.phase !== "handshake") {
      throw new Error("Not connected");
    }
    this.callbacks = callbacks;
    this.phase = "task_start";

    const payload: Record<string, unknown> = {
      event: "task_start",
      model: this.config.model,
      voice_setting: {
        voice_id: this.config.voiceId,
        ...(this.config.emotion && { emotion: this.config.emotion }),
        ...(this.config.speed !== undefined && { speed: this.config.speed }),
      },
      audio_setting: {
        sample_rate: this.config.sampleRate,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
      ...(this.config.languageBoost && {
        language_boost: this.config.languageBoost,
      }),
    };

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          reject(
            new TtsStallError(
              `Minimax task_start timed out after ${START_SESSION_TIMEOUT_MS}ms`,
            ),
          );
        }
      }, START_SESSION_TIMEOUT_MS);

      this.pending = { resolve, reject, timer, expect: "task_started" };
      this.ws!.send(JSON.stringify(payload));
    });
  }

  sendText(text: string): void {
    if (!this.ws || this.phase !== "active") return;
    this.textBuffer += text;

    // Flush at the last boundary char in the buffer, or when the buffer grows
    // past MAX_BUFFER_CHARS. This keeps phrases intact so Minimax can apply a
    // single prosody contour, while still streaming at clause granularity.
    let boundary = -1;
    for (let i = this.textBuffer.length - 1; i >= 0; i--) {
      if (FLUSH_CHARS.test(this.textBuffer[i])) {
        boundary = i;
        break;
      }
    }

    if (boundary >= 0) {
      const chunk = this.textBuffer.slice(0, boundary + 1);
      this.textBuffer = this.textBuffer.slice(boundary + 1);
      this.flushChunk(chunk);
    } else if (this.textBuffer.length >= MAX_BUFFER_CHARS) {
      this.flushChunk(this.textBuffer);
      this.textBuffer = "";
    }
  }

  finishSession(): void {
    if (!this.ws || this.phase !== "active") return;
    // Flush any buffered tail text before finishing.
    if (this.textBuffer.length > 0) {
      this.flushChunk(this.textBuffer);
      this.textBuffer = "";
    }
    this.phase = "finishing";
    this.ws.send(JSON.stringify({ event: "task_finish" }));
    this.armStallWatchdog();
  }

  private flushChunk(text: string): void {
    if (!this.ws || !text) return;
    this.ws.send(JSON.stringify({ event: "task_continue", text }));
    this.armStallWatchdog();
  }

  cancelSession(): void {
    // Minimax has no cancel event — close the socket.
    this.clearStallWatchdog();
    this.callbacks = null;
    this.phase = "idle";
    this.textBuffer = "";
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  close(): void {
    this.clearStallWatchdog();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.callbacks = null;
    this.phase = "idle";
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      const text =
        typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf-8")
            : Buffer.from(raw as ArrayBuffer).toString("utf-8");
      msg = JSON.parse(text);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error("Minimax parse error"));
      return;
    }

    const event = msg.event as string | undefined;
    const baseResp = msg.base_resp as
      | { status_code?: number; status_msg?: string }
      | undefined;

    if (event === "task_failed" || (baseResp && baseResp.status_code !== 0)) {
      this.fail(
        new Error(
          `Minimax error ${baseResp?.status_code ?? "?"}: ${
            baseResp?.status_msg ?? "unknown"
          }`,
        ),
      );
      return;
    }

    if (
      event === "connected_success" &&
      this.pending?.expect === "connected_success"
    ) {
      this.resolvePending();
      return;
    }

    if (event === "task_started" && this.pending?.expect === "task_started") {
      this.phase = "active";
      this.resolvePending();
      return;
    }

    if (event === "task_continued") {
      const data = msg.data as { audio?: string } | undefined;
      if (data?.audio) {
        this.clearStallWatchdog();
        try {
          this.callbacks?.onAudio(Buffer.from(data.audio, "hex"));
        } catch (err) {
          this.fail(
            err instanceof Error ? err : new Error("audio decode error"),
          );
        }
      }
      // Do NOT finalize on is_final — that flag marks end-of-audio-for-this-batch,
      // not end-of-session. More task_continued batches may follow if we've sent
      // additional task_continue events. Only task_finished ends the session.
      return;
    }

    if (event === "task_finished") {
      this.finalize();
      return;
    }
  }

  private resolvePending(): void {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve();
  }

  private finalize(): void {
    this.clearStallWatchdog();
    const cb = this.callbacks;
    this.callbacks = null;
    this.phase = "idle";
    this.textBuffer = "";
    cb?.onFinished();
  }

  private fail(err: Error): void {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(err);
      return;
    }
    this.clearStallWatchdog();
    const cb = this.callbacks;
    this.callbacks = null;
    this.phase = "idle";
    this.textBuffer = "";
    cb?.onError(err);
  }

  private armStallWatchdog(): void {
    this.clearStallWatchdog();
    this.stallTimer = setTimeout(() => {
      this.fail(
        new TtsStallError(
          `Minimax TTS stalled: no audio within ${AUDIO_STALL_TIMEOUT_MS}ms`,
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
}
