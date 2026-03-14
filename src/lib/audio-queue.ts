export interface AudioQueueCallbacks {
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  onError?: (error: Error) => void;
}

interface QueueEntry {
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

    const abortController = new AbortController();
    // Fetch + prepare starts immediately (parallel with other fetches)
    const audioPromise = this.fetchAndPrepare(text, abortController.signal);
    this.queue.push({ audioPromise, abortController });

    if (!this.playing) {
      this.playing = true;
      this.playNext();
    }
  }

  stopAll(): void {
    this.stopped = true;
    this.playing = false;

    for (const entry of this.queue) {
      entry.abortController.abort();
    }

    if (this.currentAudio) {
      this.currentAudio.pause();
      if (this.currentAudio.src.startsWith('blob:')) {
        URL.revokeObjectURL(this.currentAudio.src);
      }
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
      const audio = new Audio(url);

      // Wait only for 'canplay' (enough data to start), not 'canplaythrough' (full decode)
      await new Promise<void>((resolve) => {
        if (audio.readyState >= 3) {
          resolve();
          return;
        }
        audio.addEventListener('canplay', () => resolve(), { once: true });
        audio.addEventListener('error', () => resolve(), { once: true });
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
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('Audio playback error'));
        audio.play().catch(reject);
      });
    } catch (err) {
      this.callbacks.onError?.(
        err instanceof Error ? err : new Error('Playback failed')
      );
    }

    // Clean up blob URL
    if (audio.src.startsWith('blob:')) {
      URL.revokeObjectURL(audio.src);
    }
    this.currentAudio = null;

    if (this.stopped) return;

    this.currentIndex++;
    this.playNext();
  }
}
