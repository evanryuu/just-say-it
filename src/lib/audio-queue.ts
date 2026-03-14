export interface AudioQueueCallbacks {
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  onError?: (error: Error) => void;
}

interface QueueEntry {
  index: number;
  audioPromise: Promise<HTMLAudioElement | null>;
  abortController: AbortController;
}

export class AudioQueue {
  private queue: QueueEntry[] = [];
  private currentIndex = 0;
  private playing = false;
  private stopped = false;
  private currentAudio: HTMLAudioElement | null = null;
  private callbacks: AudioQueueCallbacks;
  private lang?: string;
  private hasStartedPlayback = false;

  constructor(callbacks: AudioQueueCallbacks = {}, lang?: string) {
    this.callbacks = callbacks;
    this.lang = lang;
  }

  enqueueSentence(text: string): void {
    if (this.stopped) return;

    const index = this.queue.length;
    const abortController = new AbortController();

    // Fetch TTS and pre-create a ready-to-play Audio element
    const audioPromise = this.fetchAndPrepare(text, abortController.signal);
    this.queue.push({ index, audioPromise, abortController });

    if (!this.playing) {
      this.playing = true;
      this.playNext();
    }
  }

  stopAll(): void {
    this.stopped = true;
    this.playing = false;

    // Cancel all pending fetches
    for (const entry of this.queue) {
      entry.abortController.abort();
    }

    // Stop current audio
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.removeAttribute('src');
      this.currentAudio = null;
    }

    this.queue = [];
    this.currentIndex = 0;
    this.hasStartedPlayback = false;
  }

  get isPlaying(): boolean {
    return this.playing && !this.stopped;
  }

  /**
   * Fetch TTS audio and return a pre-loaded HTMLAudioElement ready to play instantly.
   */
  private async fetchAndPrepare(
    text: string,
    signal: AbortSignal
  ): Promise<HTMLAudioElement | null> {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang: this.lang }),
        signal,
      });

      if (!res.ok) return null;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.preload = 'auto';
      audio.src = url;

      // Wait until the browser has enough data to start playing
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          URL.revokeObjectURL(url);
          reject(new Error('Audio preload failed'));
        };
        const cleanup = () => {
          audio.removeEventListener('canplaythrough', onReady);
          audio.removeEventListener('error', onError);
        };
        // If already ready
        if (audio.readyState >= 4) {
          resolve();
          return;
        }
        audio.addEventListener('canplaythrough', onReady, { once: true });
        audio.addEventListener('error', onError, { once: true });
        audio.load();
      });

      return audio;
    } catch {
      return null;
    }
  }

  private async playNext(): Promise<void> {
    if (this.stopped || this.currentIndex >= this.queue.length) {
      this.playing = false;
      if (this.hasStartedPlayback) {
        this.callbacks.onPlaybackEnd?.();
        this.hasStartedPlayback = false;
      }
      return;
    }

    const entry = this.queue[this.currentIndex];
    const audio = await entry.audioPromise;

    if (this.stopped) return;

    if (!audio) {
      this.currentIndex++;
      this.playNext();
      return;
    }

    if (!this.hasStartedPlayback) {
      this.hasStartedPlayback = true;
      this.callbacks.onPlaybackStart?.();
    }

    this.currentAudio = audio;

    try {
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => {
          // Clean up blob URL
          if (audio.src.startsWith('blob:')) {
            URL.revokeObjectURL(audio.src);
          }
          resolve();
        };
        audio.onerror = () => {
          if (audio.src.startsWith('blob:')) {
            URL.revokeObjectURL(audio.src);
          }
          reject(new Error('Audio playback error'));
        };
        audio.play().catch(reject);
      });
    } catch (err) {
      this.callbacks.onError?.(
        err instanceof Error ? err : new Error('Playback failed')
      );
    }

    this.currentAudio = null;

    if (this.stopped) return;

    this.currentIndex++;
    this.playNext();
  }
}
