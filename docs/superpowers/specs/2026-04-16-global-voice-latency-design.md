# Global Voice Default And Latency Design

**Problem**

The current voice experience has two linked user-facing issues:

1. Conversation turns still feel slow, with too much silence before the assistant starts speaking.
2. TTS voice selection is effectively environment-driven instead of being a user-controlled global default with immediate feedback.

The current architecture already merges LLM and TTS inside `/api/chat-voice`, but each chat turn still pays a fresh TTS connection and session startup cost. The topic bootstrap route also performs its own separate one-off TTS synthesis. Together, those choices increase dead air and make voice behavior harder to keep consistent across intro playback, normal turns, and future settings UI.

**Goals**

- Reduce perceived latency, especially time-to-first-audio, toward a GPT-style voice chat feel.
- Define "Tone" as the TTS `voiceId`, not LLM personality.
- Make voice selection a global app default rather than a per-conversation setting.
- Preview the newly selected voice immediately after switching it.
- Keep preview independent from in-flight conversation playback.
- Use one shared voice-resolution path across preview, intro speech, and normal chat turns.
- Implement the latency work and global voice picker together so the new setting rides on the same TTS architecture upgrade.

**Non-Goals**

- Introduce per-conversation voice settings.
- Interrupt or restart current assistant playback when the global voice changes.
- Replace browser STT in this scope.
- Build a persistent full-duplex conversation transport between browser and server.
- Redesign the broader topic picker, history, or page layout beyond the controls needed for the global voice picker.

## Product Decisions

- "Tone" maps to TTS `voiceId`.
- Voice choice is a global default.
- Switching voice previews immediately with a fixed sample phrase.
- Preview does not interrupt current conversation speech.
- The latency target prioritizes faster time-to-first-audio over perfect prosody, as long as speech remains natural.

## Architecture

### 1. Global voice becomes an app setting

Introduce a small SQLite-backed app settings store for the global default TTS voice, stored as a provider-scoped pair: `provider` + `voiceId`. The server remains the source of truth for the active default voice, while the client fetches and displays the effective setting for the currently active provider on app load.

This keeps the setting app-global on the local machine instead of browser-local and avoids duplicating fallback logic in multiple client paths.

### 2. TTS sessions accept request-scoped voice options

Extend the TTS provider abstraction so `voiceId` is supplied when a session starts rather than only through environment variables.

That change lets the same provider implementation synthesize:

- the saved global default voice,
- an explicit preview request voice,
- any future temporary override without changing provider configuration.

The provider interface should evolve toward `startSession(options, callbacks)` where `options.voiceId` is the key new field.

### 3. Warm pooled TTS connections reduce dead air

Add a server-side TTS connection pool that keeps provider connections warm and reusable across requests. Instead of opening a brand new WebSocket inside every `/api/chat-voice` request, routes borrow a ready connection, start a session with the resolved voice, and release it after synthesis finishes.

This is the main latency lever in this scope. It targets the silence before the assistant starts speaking, which is more important to perceived responsiveness than total turn duration.

### 4. Separate interactive and preview lanes

The pool should support at least two acquisition lanes:

- a `chat` lane for topic intros and normal assistant turns,
- a `preview` lane for instant voice previews.

This prevents a settings preview from waiting behind an active conversation turn and prevents preview traffic from slowing the main interactive path.

### 5. One voice-resolution path for all speech

All TTS-producing routes should resolve the active voice in this order:

1. explicit request `voiceId`, when provided,
2. saved global default voice for the active provider from app settings,
3. provider-level environment fallback.

Using a shared resolver avoids drift between preview speech, topic intro speech, and normal conversation turns.

### 6. Voice picker uses a curated catalog

The picker needs a stable list of supported voices to render labels and validate selections. For this scope, use a curated in-code catalog per provider rather than discovering voices dynamically from upstream APIs.

That keeps the UI deterministic, avoids adding another network dependency, and gives the server a clear allowlist for validating `voiceId` updates.

### 7. Intro text and intro audio become separate steps

`/api/conversations/start` should stop waiting for intro TTS synthesis before responding. Instead, it should create the conversation, persist the intro message, and return immediately so the client can render the intro text without audio-path delay.

Intro audio should move to a follow-up route keyed by the persisted intro message id rather than only by conversation id. This keeps topic bootstrap fast, avoids hiding intro text behind TTS latency, and makes the audio request unambiguous after later assistant messages exist.

### 8. Pool semantics are provider-aware

Only healthy completed sessions should be returned to the pool warm. If a provider closes its connection on cancel, the pool must discard that connection and replenish it asynchronously.

This matters especially for Minimax, whose cancel path is not reusable under the current provider behavior.

## Components

### Server

- `src/db/schema.ts`
  - Add an app-settings table or similarly small durable settings structure keyed by provider.

- `src/db/index.ts`
  - Update `ensureSchema()` to create the settings table.
  - Define first-row/bootstrap behavior so voice settings resolve safely on first use.

- `src/lib/tts/types.ts`
  - Extend the session API to accept request-scoped synthesis options including `voiceId`.

- `src/lib/tts/volc.ts`
  - Start sessions with a supplied `voiceId` instead of relying purely on env-configured speaker values.

- `src/lib/tts/minimax.ts`
  - Start sessions with a supplied `voiceId`.

- `src/lib/tts/index.ts`
  - Keep provider creation provider-agnostic while exposing the upgraded session API.

- `src/lib/tts/pool.ts`
  - New pool module that manages warm provider connections, lane-aware acquisition, stale connection replacement, and release behavior.

- `src/lib/tts/voice-settings.ts`
  - New helper module for loading the saved default voice and resolving the final effective voice.

- `src/lib/tts/voice-catalog.ts`
  - New curated catalog of selectable voices for the active provider.
  - Shared by settings validation and picker rendering.

- `src/app/api/settings/voice/route.ts`
  - `GET` returns the effective global default voice for the active provider plus its source (`saved` or `env`).
  - `PATCH` validates and persists a new global default voice for the active provider.

- `src/app/api/tts/preview/route.ts`
  - Synthesizes a fixed sample phrase using the selected voice via the preview lane.

- `src/app/api/conversations/start/route.ts`
  - Create the conversation and persist the intro text.
  - Return without waiting for intro audio synthesis.

- `src/app/api/messages/[id]/audio/route.ts`
  - Synthesizes a specific persisted assistant message through the pooled TTS path after bootstrap returns.
  - The initial client use is the intro message returned by conversation bootstrap.
  - Reuses the shared voice resolver and chat-lane acquisition.

- `src/app/api/chat-voice/route.ts`
  - Reuse shared voice resolution.
  - Acquire a warm pooled chat connection.
  - Add pool timing markers around session setup and first audio.
  - Only retry pooled acquisition/setup failures before any text has been handed to TTS or any audio has been emitted.

### Client

- `src/hooks/use-voice-chat.ts`
  - Load the current global default voice.
  - Keep chat/bootstrap requests compatible with server-side voice resolution.
  - Keep conversation playback independent from voice-preview playback.

- `src/app/page.tsx`
  - Add a global voice picker in the top-level UI.
  - Changing the picker saves the new default and triggers immediate preview.

- `src/lib/audio-stream-player.ts`
  - Continue to handle streamed playback for turns and previews.
  - Add client timing hooks for first chunk and actual playback start if needed for latency measurement.

- preview playback controller
  - Use a dedicated short-lived audio player instance for picker previews rather than reusing the conversation player ref.
  - This keeps previews from interrupting current assistant speech and avoids conversation cleanup code stopping previews unintentionally.

## Data Flow

### App boot

1. Client loads topics as it does today.
2. Client fetches the global default voice from `GET /api/settings/voice`.
3. Server returns the effective `voiceId` plus whether it came from a saved setting or env fallback.
4. UI renders the picker with that effective voice.
5. The TTS pool warms lazily on first use rather than blocking initial page load.

### Switching the global voice

1. User picks a voice in the global picker.
2. Client calls `PATCH /api/settings/voice` with the selected `voiceId`.
3. Server validates the `voiceId` against the curated catalog for the active provider and persists the new default voice for that provider.
4. Client updates local picker state after success.
5. Client calls `POST /api/tts/preview` with that same `voiceId`.
6. Server acquires the preview lane, synthesizes a fixed sample phrase, and returns or streams preview audio.
7. Client plays the preview without interrupting any current conversation playback.

### Starting a topic conversation

1. User selects a topic.
2. Client calls `POST /api/conversations/start`.
3. Server creates the conversation row and intro message, then returns immediately without waiting for audio synthesis.
4. Client shows the intro text immediately.
5. Client calls `POST /api/messages/:introMessageId/audio`.
6. Server resolves the effective voice through the shared resolver, acquires the chat lane from the pool, and synthesizes intro audio.
7. Client plays the intro audio if available, then enters listening mode.

### Normal chat turn

1. User speaks and client finishes STT capture.
2. Client posts to `POST /api/chat-voice` with messages plus current topic/conversation context.
3. Server resolves the topic prompt and effective voice.
4. Server acquires a warm chat-lane TTS connection.
5. Server starts the TTS session immediately with the resolved `voiceId`.
6. LLM streaming and TTS setup run in parallel.
7. As text deltas arrive, the server forwards them into TTS with minimal buffering.
8. Server streams text deltas and audio chunks back over SSE.
9. Server persists the assistant message and releases the pooled session.

## Latency Strategy

This scope optimizes for lower silence before speech rather than solely lower total request time.

### Primary levers

- Reuse warm TTS connections across requests.
- Start TTS sessions as early as possible after request arrival.
- Feed text into TTS with minimal buffering so speech begins earlier.
- Keep degraded text streaming if TTS fails instead of failing the whole turn.
- Avoid blocking bootstrap text rendering on intro-audio synthesis.

### Metrics to capture

Expand timing instrumentation to measure:

- pool acquisition start and completion,
- TTS session start completion,
- first LLM token,
- first audio chunk,
- last audio chunk,
- client playback start,
- total turn duration.

The main success metric is lower time-to-first-audio and lower time-to-playback-start.

## Error Handling

- If loading the global voice on app boot fails, the app still loads and falls back gracefully.
- If saving a new default voice fails, the picker reverts and shows an inline error.
- If preview synthesis fails, keep the new default saved and show a non-blocking preview error.
- If intro audio synthesis fails, still return intro text and allow the conversation to proceed.
- If pooled TTS acquisition times out or synthesis stalls during `/api/chat-voice`, continue streaming text and mark the turn degraded.
- If a pooled connection closes unexpectedly before any text has been sent to TTS or any audio has been emitted, discard it, reconnect once, and retry setup.
- If failure happens after TTS has already received text or emitted audio, degrade instead of retrying to avoid duplicated or truncated speech.
- If a provider closes its socket on cancel, discard that connection from the pool and replenish it asynchronously rather than trying to reuse it warm.
- If preview cannot start quickly, fail fast rather than hanging the picker interaction.

## Testing Strategy

### Unit tests

- voice-resolution order prefers explicit request voice, then saved global default, then env fallback,
- provider-scoped settings select the right saved voice for the active provider,
- voice-catalog validation rejects unknown voices and accepts supported ones,
- settings persistence helpers read and write the saved default correctly,
- preview phrase helpers stay stable and non-empty.

### Route-level tests

- `GET /api/settings/voice` returns the saved default when present,
- `GET /api/settings/voice` returns env-backed effective voice when no saved row exists,
- `PATCH /api/settings/voice` validates and persists supported voices,
- `POST /api/tts/preview` uses the requested voice,
- `POST /api/conversations/start` returns conversation + intro text without waiting for intro audio,
- `POST /api/messages/[id]/audio` uses the resolved voice for intro audio when called with the persisted intro message id,
- `POST /api/chat-voice` uses the resolved voice and degrades cleanly on TTS failure.

### Pool tests

- pooled connections are reused across sequential requests,
- broken connections are replaced,
- cancelled non-reusable provider sessions are discarded and replenished,
- preview lane activity does not block active chat-lane synthesis.

### Manual verification

- changing the global voice updates all future intro and chat playback,
- preview plays immediately after switching voice,
- preview does not interrupt current assistant speech,
- time-to-first-audio is measurably lower than the current per-turn fresh connection model.

## Success Criteria

- Users can see and change a global default TTS voice in the main app UI.
- Switching the voice immediately plays a fixed preview phrase.
- Future conversation intros and normal turns use the selected voice by default.
- Current playback is not interrupted when the voice changes.
- Measured time-to-first-audio is lower than the current baseline under the same provider.
- TTS failures degrade to visible text instead of breaking the whole turn.
