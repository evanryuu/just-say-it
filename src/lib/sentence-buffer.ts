const SENTENCE_TERMINATORS = /([.!?。！？\n])\s*/;

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
      const match = SENTENCE_TERMINATORS.exec(this.buffer);
      if (!match) break;

      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);

      if (sentence) {
        this.onSentence(sentence);
      }
    }
  }
}
