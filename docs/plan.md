# Implementation Plan

## Phase 1: WebSocket TTS

**Goal:** Replace per-sentence HTTP POST with a single persistent WebSocket connection to VolcEngine V3, reducing latency and connection overhead.

**Status:** Complete. Shipped with a simpler architecture than originally planned — see "Shipped architecture" below.

### Context

- Current flow: each sentence → `POST /api/tts` → VolcEngine HTTP chunked → base64 MP3 chunks → stream to client
- Problem: 5–8 sentences = 5–8 round-trips with connection setup overhead
- VolcEngine V3 bidirectional endpoint: `wss://openspeech.bytedance.com/api/v3/tts/bidirection`
- Protocol docs already in repo: `docs/volc/websocket.md`

### Key insight from VolcEngine docs

> The bidirectional API handles fragmented or overly long text internally, organizing it into appropriately sized sentences. When integrating with LLMs, feed streaming output text directly into this API — do NOT add your own sentence splitting or batching logic. (docs/volc/websocket.md §1.1)

This means **`SentenceBuffer` is no longer needed**. LLM tokens go directly into the WebSocket, and VolcEngine handles segmentation. This also produces more natural speech with better emotion than splitting into separate requests.

### Shipped architecture

```
Previous:  LLM stream → SentenceBuffer → N × POST /api/tts → N × VolcEngine HTTP → N × MP3 blobs → AudioQueue
Shipped:   Client POST /api/chat-voice {messages} → server runs LLM + VolcEngine WS TTS in parallel
           → merged SSE with {type:"text",delta} and {type:"audio",data:base64}
           → client AudioStreamPlayer (MediaSource) plays gaplessly
```

The route `/api/chat-voice` owns both LLM and TTS server-side. Text tokens from ARK are fed directly into the VolcEngine WebSocket; MP3 chunks are base64-encoded and interleaved with text deltas in a single SSE stream. The client never talks to two endpoints.

This is simpler than the originally planned `/api/tts/stream` route (which would have required the client to forward LLM tokens between `/api/chat` and `/api/tts/stream`). Merging on the server cuts one hop and one stream-plumbing layer.

### VolcEngine WebSocket protocol summary

- **Endpoint:** `wss://openspeech.bytedance.com/api/v3/tts/bidirection`
- **Auth headers:** `X-Api-App-Key`, `X-Api-Access-Key`, `X-Api-Resource-Id` (same env vars as current HTTP)
- **Binary frame format:** 4-byte header + optional event(4B) + session_id_size(4B) + session_id + payload_size(4B) + payload
  - Byte 0: `0x11` (v1, 4-byte header)
  - Byte 1: message type (0x1=client request, 0x9=server response, 0xB=audio response, 0xF=error) + flags (0x4=has event)
  - Byte 2: serialization (0x1=JSON, 0x0=Raw) + compression (0x0=none, 0x1=gzip)
  - Byte 3: reserved `0x00`
- **Session lifecycle:**
  1. StartConnection (event=1) → wait for ConnectionStarted (event=50)
  2. StartSession (event=100, payload=TTS config) → wait for SessionStarted (event=150)
  3. TaskRequest (event=200, payload={text}) — send multiple times as LLM tokens arrive
  4. FinishSession (event=102) → wait for SessionFinished (event=152)
  5. FinishConnection (event=2) → done
- **Audio responses:** TTSResponse (event=352) contains raw MP3 bytes; TTSSentenceStart (350) / TTSSentenceEnd (351) bracket each synthesized sentence
- **Connection reuse:** One connection supports multiple sequential sessions (not concurrent). After SessionFinished, can StartSession again without reconnecting.
- **CancelSession (event=101):** For barge-in — immediately stops synthesis and releases server resources. Must be sent after SessionStarted and before FinishSession.

### What was built

1. **`src/lib/volc-tts-ws.ts`** — Server-side WebSocket client with binary frame builder/parser, connection + session lifecycle, and callback-based audio/error emission. API: `connect()`, `startSession(callbacks)`, `sendText(text)`, `finishSession()`, `cancelSession()`, `close()`.

2. **`src/app/api/chat-voice/route.ts`** — Merged LLM+TTS route. Opens ARK LLM stream and VolcEngine TTS WebSocket in parallel, pipes tokens into the WS as they arrive, buffers if TTS setup lags, and emits a unified SSE stream with interleaved text deltas and base64 audio chunks. Cancels TTS session on client disconnect (barge-in).

3. **`src/lib/audio-stream-player.ts`** — New MediaSource-based player (replaces the old `AudioQueue`). Appends MP3 chunks into a single SourceBuffer for gapless playback; exposes `enqueueChunk(base64)`, `markFinished()`, `stopAll()`.

4. **`src/hooks/use-voice-chat.ts`** — Uses `AudioStreamPlayer`, calls `/api/chat-voice` once per turn, parses the merged SSE stream, and aborts the fetch on barge-in (server-side cancellation flows from that).

### Cleanup (completed 2026-04-15)

- Removed `src/lib/sentence-buffer.ts` — VolcEngine WS handles segmentation
- Removed `src/lib/audio-queue.ts` — superseded by `audio-stream-player.ts`
- Removed `src/app/api/tts/route.ts` — unused after chat-voice merge

### Decisions made

- **No client-side sentence splitting** — VolcEngine handles it (per their best practices)
- **Binary protocol** — must implement; no JSON-only option for the bidirectional endpoint
- **Per-turn WebSocket** — one WS connection per conversation turn; can upgrade to persistent connection reuse later
- **CancelSession for barge-in** — event 101 on client abort, not just dropping the connection
- **Merge LLM+TTS server-side** — preferred over the two-endpoint design in the original plan; removes a client hop

---

## Phase 1.5: Sesame-like responsiveness + Minimax TTS provider

**Goal:** Drive time-to-first-audio and tail latency toward Sesame AI CSM feel. Add Minimax as a second TTS provider so we can A/B against VolcEngine for naturalness (Minimax 2.8 supports inline paralinguistic tags like `(laughs)`, `(sighs)`).

**Motivation:** Current chat-voice turns measured at 3.5s (good) and 19.2s (bad) — no visibility into where the tail comes from, no timeouts, and each turn pays a full WS handshake + session start to cn-beijing.

### Step 1 — Server-side timing instrumentation (do first, low risk)

Add phase markers in `src/app/api/chat-voice/route.ts`:

- `t0` — request received
- `t_llm_first_token` — first chunk from ARK
- `t_tts_connected` — VolcEngine `ConnectionStarted`
- `t_tts_session_started` — `SessionStarted`
- `t_first_audio` — first `TTSResponse` chunk
- `t_last_audio` — last audio chunk
- `t_session_finished` — `SessionFinished`
- `t_done` — stream closed

Emit a single-line JSON log per turn with deltas. Also log `messages.length` and last user message length so we can spot pathological inputs (empty/whitespace transcripts that produce generic LLM replies).

### Step 2 — Timeouts and fail-fast

In `VolcTtsWs`:
- `connect()` — 3s timeout
- `startSession()` — 3s timeout
- New internal watchdog: if no audio chunk within **8s** of last `sendText` / `finishSession`, reject session with `TtsStallError`

In chat-voice route: on any TTS error, keep streaming LLM text to client (degraded mode — user still sees response) and emit `{type:"error","reason":"tts_stall"}` so client can fall back to a "tap to read aloud" affordance or just display text.

### Step 3 — Provider abstraction

New interface in `src/lib/tts/types.ts`:

```ts
export interface TtsProvider {
  connect(): Promise<void>;
  startSession(cb: TtsSessionCallbacks): Promise<void>;
  sendText(text: string): void;
  finishSession(): void;
  cancelSession(): void;
  close(): void;
  readonly isConnected: boolean;
  readonly hasActiveSession: boolean;
}

export interface TtsSessionCallbacks {
  onAudio(chunk: Buffer, format: 'mp3'): void;
  onFinished(): void;
  onError(err: Error): void;
}
```

Move `src/lib/volc-tts-ws.ts` → `src/lib/tts/volc.ts` implementing `TtsProvider`.

New `src/lib/tts/minimax.ts` using the Minimax bidirectional WS at `wss://api.minimaxi.com/ws/v1/t2a_v2`:
- Auth: `Authorization: Bearer ${MINIMAX_API_KEY}` header on handshake
- Handshake: wait for `connected_success`
- Session start: `{event:"task_start", model, voice_setting, audio_setting, ...}` → wait for `task_started`
- Per token: `{event:"task_continue", text}` (text concatenated, not split — Minimax handles segmentation like VolcEngine)
- Audio arrives in `task_continued` events, **hex-encoded** (not base64 — must `Buffer.from(hex, 'hex')` before handing to `onAudio`)
- Finish: `{event:"task_finish"}` → wait for `task_finished`
- Cancel: no explicit cancel event in spec — close the socket (acceptable tradeoff; session is short-lived)

New env vars:
- `TTS_PROVIDER` — `"volc" | "minimax"` (default: `"volc"`)
- `MINIMAX_API_KEY`
- `MINIMAX_TTS_MODEL` — default `"speech-2.8-turbo"` (turbo = lower latency than hd)
- `MINIMAX_TTS_VOICE_ID` — e.g. `"male-qn-qingse"` or an English moss_audio voice
- `MINIMAX_TTS_EMOTION` — optional (`happy`, `calm`, etc.)

Factory in `src/lib/tts/index.ts`:

```ts
export function createTtsProvider(): TtsProvider { /* reads env, returns new instance */ }
```

chat-voice route imports only `createTtsProvider` — stays provider-agnostic.

### Step 4 — Connection pooling (after Steps 1–3 validate the hot path)

Server-process-scoped singleton TTS connection per provider, managed in `src/lib/tts/pool.ts`:

- Lazy-open on first request
- Serialize session acquisition with a promise-based mutex (`acquire(): Promise<PooledSession>` → waits if another turn is mid-session, since both providers support only one session at a time per connection)
- `release()` runs `finishSession` (or `cancelSession` on abort) and returns the connection to the idle pool
- Reconnect on unexpected close with exponential backoff
- Health check: ping-like no-op if available; otherwise rely on lazy reconnect

**Caveat:** Next.js dev-mode HMR recreates module state, so pooling only pays off in production (`next start`). That's fine.

### Step 5 — Client-side playback tuning

In `AudioStreamPlayer`:
- Log first-chunk-received and first-`playing`-event timestamps so we can measure client-side buffering delay
- Consider setting `audio.preload = 'auto'` and calling `audio.play()` immediately after the first `appendBuffer` (already done, verify)
- If MediaSource adds >200ms before playback, investigate switching first chunk to an `Audio(blobURL)` fast-path and handing off to MediaSource for subsequent chunks

### Non-goals for Phase 1.5

- Cross-turn WS reuse that spans multiple HTTP requests in the same browser session via keep-alive — out of scope (would require a long-lived server-side session broker)
- STT latency work — deferred to Phase 3
- LLM-side latency (streaming smarter, prefetch, speculative decoding) — deferred

### Order of operations

1. Step 1 (instrumentation) — deploy, capture 10–20 real turns, identify actual culprit
2. Step 2 (timeouts) — eliminate the 19s pathological case
3. Step 3 (provider abstraction + Minimax) — parallel track, can start once Step 1 is merged
4. Step 4 (pooling) — only if Step 1 data shows handshake is a meaningful fraction of latency
5. Step 5 (client tuning) — based on Step 1 client-side numbers

---

## Phase 2: Topics + Conversation Persistence

**Goal:** Let users choose conversation topics with tailored system prompts, and persist all conversations for progress tracking over time.

**Status:** In progress

### Scope

- Topic presets with system prompts (language learning, interview prep, etc.)
- Custom topic creation
- Conversation storage (messages, topic, timestamps)
- Session history browsing
- Automatic topic-bound assistant greeting on conversation start
- Progress analytics (vocabulary range, fluency metrics, LLM-evaluated scoring)

### Current status

- Topic/topic-history UI and SQLite-backed topic + conversation APIs are in progress
- New conversations now bootstrap with a persisted assistant greeting tied to the selected topic
- The client now sends the active `topicId`/`conversationId` reliably instead of falling back to `null`
- Remaining follow-up work: broaden persistence coverage, polish analytics, and add deeper automated coverage around the route layer

### Key decisions to make

- Storage: localStorage prototype → SQLite/Postgres for production
- Schema design for conversations and topics
- What metrics to track and how to compute them

---

## Phase 3: Dedicated STT Provider

**Goal:** Replace Web Speech API with a server-side STT provider for cross-browser support, better accuracy, and privacy.

**Status:** Not started

### Candidates

- VolcEngine ASR (same vendor as TTS)
- FunASR (self-hosted, Mandarin-optimized)
- Whisper (multilingual, higher latency)
- Deepgram / AssemblyAI (managed, low latency)

### Key decisions to make

- Provider selection
- Client audio capture (MediaRecorder → WebSocket to server)
- Streaming vs. batch transcription
