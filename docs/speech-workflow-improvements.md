# Speech Workflow Improvement Plan

## 1. Reduce TTS HTTP Requests

**Current problem:** Each sentence from the LLM response triggers a separate `POST /api/tts` request to VolcEngine. A typical AI reply of 5–8 sentences means 5–8 round-trips, each with connection overhead and per-request billing.

**Possible directions:**

- **Larger chunk batching** — Increase `SentenceBuffer` thresholds so multiple sentences are merged into fewer, longer TTS calls. Trade-off: higher latency on later chunks, but significantly fewer requests.
- **WebSocket / bidirectional streaming** — Replace the per-sentence HTTP POST with a single persistent connection (VolcEngine V3 supports a bidirectional endpoint). Feed sentences into the stream as they arrive; receive audio chunks continuously over one connection.
- **Client-side concatenation** — Keep the current request pattern but merge adjacent short sentences before sending, capping at a character/token budget per request.

## 2. Replace Browser-Native STT with a Dedicated Provider

**Current problem:** `SpeechRecognition` (Web Speech API) delegates to Google's servers in Chromium browsers. It is unavailable in Firefox/Safari, offers no language-model customization, and provides limited control over latency, accuracy, and privacy.

**Possible directions:**

- **VolcEngine ASR** — ByteDance offers streaming ASR alongside TTS. Using the same vendor simplifies auth and billing, and the service supports Mandarin well.
- **FunASR (Alibaba open-source)** — Self-hostable, supports real-time streaming, Mandarin-optimized, zero ongoing cost after deployment.
- **Whisper (OpenAI / open-source)** — Can run server-side (or even in-browser via WASM). Excellent multilingual accuracy; trade-off is higher latency unless using a streaming wrapper like `faster-whisper`.
- **Deepgram / AssemblyAI** — Managed services with WebSocket streaming APIs, low latency, generous free tiers.

**Key considerations:** whichever provider is chosen, the client needs to stream raw PCM/WebM audio to the server (via WebSocket or chunked upload) and receive transcript events back — replacing the browser-native `onresult` flow entirely.

## 3. Topic-Based Conversations

**Current problem:** Every conversation starts blank. There is no way to steer the AI toward a specific subject, tone, or knowledge domain before speaking.

**Possible directions:**

- **Topic presets** — A set of predefined topics (e.g., "Daily English Practice", "Tech Interview Prep", "Travel Chinese") each backed by a system prompt that shapes the AI's persona, vocabulary level, and response style.
- **Custom topic creation** — Let users define their own topic with a name, description, and optional system prompt, stored in `localStorage` or a lightweight backend.
- **Topic-aware context** — Attach the active topic's system prompt to every `/api/chat` request. Optionally inject reference material or vocabulary lists into the conversation context.
- **UI integration** — A topic selector on the home screen or a drawer/modal before starting a voice session. Display the active topic during conversation so users know the current context.
