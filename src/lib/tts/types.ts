export class TtsStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsStallError';
  }
}

export interface TtsSessionCallbacks {
  onAudio(chunk: Buffer): void;
  onFinished(): void;
  onError(error: Error): void;
}

export interface TtsCapabilities {
  audioFormat: 'mp3' | 'opus' | 'pcm';
  sampleRate: number;
  /** Whether the provider supports a graceful cancel mid-session (vs. socket close). */
  supportsCancel: boolean;
  /** Whether the provider supports inline paralinguistic tags like (laughs), (sighs). */
  supportsParalinguistic: boolean;
}

export interface TtsProvider {
  readonly capabilities: TtsCapabilities;
  readonly isConnected: boolean;
  readonly hasActiveSession: boolean;
  connect(): Promise<void>;
  startSession(callbacks: TtsSessionCallbacks): Promise<void>;
  sendText(text: string): void;
  finishSession(): void;
  cancelSession(): void;
  close(): void;
}
