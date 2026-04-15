import { MinimaxTtsProvider } from './minimax';
import type { TtsProvider } from './types';
import { VolcTtsProvider } from './volc';

export { TtsStallError } from './types';
export type {
  TtsCapabilities,
  TtsProvider,
  TtsSessionCallbacks,
} from './types';

export function createTtsProvider(): TtsProvider {
  const name = (process.env.TTS_PROVIDER || 'volc').toLowerCase();
  switch (name) {
    case 'minimax':
      return new MinimaxTtsProvider();
    case 'volc':
    case 'volcengine':
      return new VolcTtsProvider();
    default:
      throw new Error(`Unknown TTS_PROVIDER: ${name}`);
  }
}
