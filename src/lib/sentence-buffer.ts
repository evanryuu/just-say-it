// First chunk uses clause-level splitting for fast time-to-first-audio.
// Subsequent chunks use sentence-level splitting to reduce total TTS requests.
const CLAUSE_TERMINATORS = /([.!?。！？\n,;:，；：、])\s*/;
const SENTENCE_TERMINATORS = /([.!?。！？\n])\s*/;

const FIRST_CHUNK_MIN_LENGTH = 8;
const LATER_CHUNK_MIN_LENGTH = 20;

export class SentenceBuffer {
  private buffer = '';
  private emittedCount = 0;
  private onSentence: (sentence: string) => void;

  constructor(onSentence: (sentence: string) => void) {
    this.onSentence = onSentence;
  }

  feed(token: string): void {
    this.buffer += token;
    this.drain();
  }

  flush(): void {
    const remaining = this.buffer.trim();
    if (remaining) {
      this.onSentence(remaining);
    }
    this.buffer = '';
  }

  reset(): void {
    this.buffer = '';
    this.emittedCount = 0;
  }

  private drain(): void {
    while (true) {
      const isFirst = this.emittedCount === 0;
      const pattern = isFirst ? CLAUSE_TERMINATORS : SENTENCE_TERMINATORS;
      const minLength = isFirst ? FIRST_CHUNK_MIN_LENGTH : LATER_CHUNK_MIN_LENGTH;

      const match = pattern.exec(this.buffer);
      if (!match) break;

      const end = match.index + match[0].length;
      const candidate = this.buffer.slice(0, end).trim();

      if (candidate.length < minLength) {
        break;
      }

      this.buffer = this.buffer.slice(end);

      if (candidate) {
        this.onSentence(candidate);
        this.emittedCount++;
      }
    }
  }
}
