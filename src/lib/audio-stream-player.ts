/**
 * Client-side audio player for streaming MP3 chunks.
 *
 * Uses the MediaSource API to append MP3 chunks into a single continuous
 * audio stream, avoiding the gaps that occur when playing individual
 * AudioBuffer nodes sequentially.
 */

export interface AudioStreamPlayerCallbacks {
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  onError?: (error: Error) => void;
}

export class AudioStreamPlayer {
  private audio: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private pendingChunks: Uint8Array[] = [];
  private stopped = false;
  private hasStartedPlayback = false;
  private finished = false;
  private callbacks: AudioStreamPlayerCallbacks;
  private objectUrl: string | null = null;

  constructor(callbacks: AudioStreamPlayerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * Enqueue a base64-encoded MP3 chunk for playback.
   * Chunks are appended into a MediaSource for gapless streaming.
   */
  enqueueChunk(base64: string): void {
    if (this.stopped) return;

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    if (!this.mediaSource) {
      this.initMediaSource();
    }

    this.pendingChunks.push(bytes);
    this.flushPending();
  }

  /**
   * Signal that no more audio chunks will arrive.
   * Calls endOfStream() once all pending data is appended.
   */
  markFinished(): void {
    this.finished = true;
    this.tryEndOfStream();
  }

  /**
   * Stop all playback immediately (for barge-in).
   */
  stopAll(): void {
    this.stopped = true;
    this.pendingChunks = [];

    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio = null;
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    this.mediaSource = null;
    this.sourceBuffer = null;
    this.hasStartedPlayback = false;
  }

  get isPlaying(): boolean {
    return this.hasStartedPlayback && !this.stopped;
  }

  private initMediaSource(): void {
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;

    const audio = new Audio();
    this.audio = audio;
    this.objectUrl = URL.createObjectURL(mediaSource);
    audio.src = this.objectUrl;

    mediaSource.addEventListener(
      'sourceopen',
      () => {
        if (this.stopped || !this.mediaSource) return;
        try {
          this.sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
          this.sourceBuffer.addEventListener('updateend', () => {
            this.flushPending();
            this.tryEndOfStream();
          });
          this.flushPending();
        } catch (err) {
          this.callbacks.onError?.(
            err instanceof Error ? err : new Error('Failed to init SourceBuffer'),
          );
        }
      },
      { once: true },
    );

    audio.addEventListener('playing', () => {
      if (!this.hasStartedPlayback && !this.stopped) {
        this.hasStartedPlayback = true;
        this.callbacks.onPlaybackStart?.();
      }
    });

    audio.addEventListener('ended', () => {
      if (this.hasStartedPlayback) {
        this.hasStartedPlayback = false;
        this.callbacks.onPlaybackEnd?.();
      }
    });

    audio.addEventListener('error', () => {
      const err = audio.error;
      this.callbacks.onError?.(
        new Error(`Audio error: ${err?.message || err?.code || 'unknown'}`),
      );
    });
  }

  private flushPending(): void {
    if (
      this.stopped ||
      !this.sourceBuffer ||
      this.sourceBuffer.updating ||
      this.pendingChunks.length === 0
    ) {
      return;
    }

    // Merge all pending chunks into one append for efficiency
    const totalLength = this.pendingChunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.pendingChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.pendingChunks = [];

    try {
      this.sourceBuffer.appendBuffer(merged);
    } catch (err) {
      this.callbacks.onError?.(
        err instanceof Error ? err : new Error('appendBuffer failed'),
      );
      return;
    }

    // Start playback as soon as we have data
    if (this.audio && this.audio.paused) {
      this.audio.play().catch((err) => {
        this.callbacks.onError?.(
          err instanceof Error ? err : new Error('play() failed'),
        );
      });
    }
  }

  private tryEndOfStream(): void {
    if (
      this.finished &&
      this.mediaSource &&
      this.mediaSource.readyState === 'open' &&
      this.sourceBuffer &&
      !this.sourceBuffer.updating &&
      this.pendingChunks.length === 0
    ) {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // Can fail if already ended
      }
    }
  }
}
