# Implementation Plan

## Phase 1: WebSocket TTS (current focus)

**Goal:** Replace per-sentence HTTP POST with a single persistent WebSocket connection to VolcEngine V3, reducing latency and connection overhead.

**Status:** In progress — core implementation done, needs testing

### Context

- Current flow: each sentence → `POST /api/tts` → VolcEngine HTTP chunked → base64 MP3 chunks → stream to client
- Problem: 5–8 sentences = 5–8 round-trips with connection setup overhead
- VolcEngine V3 bidirectional endpoint: `wss://openspeech.bytedance.com/api/v3/tts/bidirection`
- Protocol docs already in repo: `docs/volc/websocket.md`

### Key insight from VolcEngine docs

> The bidirectional API handles fragmented or overly long text internally, organizing it into appropriately sized sentences. When integrating with LLMs, feed streaming output text directly into this API — do NOT add your own sentence splitting or batching logic. (docs/volc/websocket.md §1.1)

This means **`SentenceBuffer` is no longer needed**. LLM tokens go directly into the WebSocket, and VolcEngine handles segmentation. This also produces more natural speech with better emotion than splitting into separate requests.

### Architecture

```
Current:  LLM stream → SentenceBuffer → N × POST /api/tts → N × VolcEngine HTTP → N × MP3 blobs → AudioQueue
New:      LLM stream → POST /api/tts/stream (single request) → server-side WS → VolcEngine bidirectional → continuous MP3 stream → client plays chunks
```

The WebSocket lives server-side (requires `VOLC_TTS_*` credentials). The client sends one request per conversation turn and receives a continuous audio stream.

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

### Steps

1. **`src/lib/volc-tts-ws.ts` — Server-side WebSocket client**
   - Implement binary frame builder/parser for the protocol
   - Manage connection + session lifecycle
   - Expose: `connect()`, `startSession(config)`, `sendText(text)`, `finishSession()`, `cancelSession()`, `close()`
   - Emit audio chunks and events via callbacks

2. **`src/app/api/tts/stream/route.ts` — New streaming TTS route**
   - Client sends: `POST /api/tts/stream` with body as SSE stream of text chunks (from LLM)
   - Server opens VolcEngine WebSocket, starts session, forwards text chunks as TaskRequests
   - Streams MP3 audio bytes back to client as they arrive from TTSResponse events
   - On client disconnect or stream end: sends FinishSession (or CancelSession for barge-in)

3. **`src/lib/audio-queue.ts` — Adapt for single streaming response**
   - Instead of N independent fetches, consume one `ReadableStream` of MP3 bytes
   - Use `MediaSource` API or accumulate-and-play approach for continuous audio playback
   - Keep barge-in support (stop playback + signal server to cancel)

4. **`src/hooks/use-voice-chat.ts` — Update integration**
   - Remove `SentenceBuffer` usage
   - Stream LLM chunks directly to the new TTS endpoint
   - Single audio stream response replaces N AudioQueue entries

5. **Cleanup**
   - Remove or deprecate `src/lib/sentence-buffer.ts`
   - Keep `src/app/api/tts/route.ts` as fallback (optional)

### Decisions made

- **No client-side sentence splitting** — VolcEngine handles it (per their best practices)
- **Binary protocol** — must implement; no JSON-only option for the bidirectional endpoint
- **Per-turn WebSocket** — start with one WS connection per conversation turn; can upgrade to persistent connection reuse later
- **CancelSession for barge-in** — use event 101 instead of just dropping the connection

### Files to touch

- New: `src/lib/volc-tts-ws.ts` — binary protocol + WebSocket client
- New: `src/app/api/tts/stream/route.ts` — streaming TTS route
- Modify: `src/lib/audio-queue.ts` — streaming playback
- Modify: `src/hooks/use-voice-chat.ts` — new integration
- Remove: `src/lib/sentence-buffer.ts` (after migration)

---

## Phase 2: Topics + Conversation Persistence

**Goal:** Let users choose conversation topics with tailored system prompts, and persist all conversations for progress tracking over time.

**Status:** Not started

### Scope

- Topic presets with system prompts (language learning, interview prep, etc.)
- Custom topic creation
- Conversation storage (messages, topic, timestamps)
- Session history browsing
- Progress analytics (vocabulary range, fluency metrics, LLM-evaluated scoring)

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
