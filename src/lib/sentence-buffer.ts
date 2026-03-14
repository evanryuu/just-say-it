// Split on sentence-ending punctuation AND clause boundaries (commas, semicolons, colons)
// This produces smaller chunks so TTS can start sooner.
const CLAUSE_TERMINATORS = /([.!?。！？\n,;:，；：、])\s*/;

// Minimum character count before we emit a clause.
// Prevents overly short TTS requests (e.g. "Hi," alone sounds unnatural).
const MIN_CHUNK_LENGTH = 8;

export class SentenceBuffer {
  private buffer = '';
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
  }

  private drain(): void {
    while (true) {
      const match = CLAUSE_TERMINATORS.exec(this.buffer);
      if (!match) break;

      const end = match.index + match[0].length;
      const candidate = this.buffer.slice(0, end).trim();

      // If the chunk is too short, keep buffering
      if (candidate.length < MIN_CHUNK_LENGTH) {
        break;
      }

      this.buffer = this.buffer.slice(end);

      if (candidate) {
        this.onSentence(candidate);
      }
    }
  }
}
