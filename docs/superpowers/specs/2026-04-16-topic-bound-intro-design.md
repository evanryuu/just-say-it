# Topic-Bound Intro Design

**Problem**

The current topic flow has two user-facing failures:

1. Selecting a topic does not reliably influence the server request, so conversations fall back to the generic assistant prompt.
2. Starting a new topic feels cold because the assistant waits for the user to speak first instead of greeting and guiding them.

**Goals**

- Make every turn reliably use the selected topic prompt.
- Automatically create a short assistant greeting when a topic is selected.
- Speak that greeting through the existing `/api/chat-voice` audio path.
- Persist the greeting as the first message in the conversation history.
- Keep barge-in behavior working while the intro is speaking.

**Non-Goals**

- Rework the visual design of the topic picker or history sidebar.
- Change the TTS provider architecture.
- Solve the broader conversation-persistence gaps beyond the intro/turn flow needed here.

## Architecture

### 1. Server owns conversation bootstrap

Introduce a small server-side conversation bootstrap path that:

- creates a conversation row for the chosen topic,
- generates a short topic-specific assistant intro,
- stores that intro as the first assistant message,
- returns the created conversation and intro text.

This keeps topic behavior authoritative on the server and avoids duplicating greeting logic in the client.

### 2. Client treats topic selection as conversation start

When the user picks a topic, the client will:

- call the bootstrap endpoint,
- set the returned `conversationId`,
- show the intro immediately in the message list,
- speak the intro automatically,
- then enter listening mode so the user can respond naturally.

### 3. Topic binding becomes explicit

The voice-chat hook will stop relying on stale closure state for request metadata. Instead, it will read the latest topic and conversation ids from refs that are updated alongside React state. That ensures `/api/chat-voice` always receives the active topic/conversation identifiers.

### 4. Minimal persisted turn model

For this scope, the server will persist:

- the generated intro assistant message during bootstrap,
- user and assistant messages during normal `/api/chat-voice` turns.

That gives history enough data to reopen the intro and later turns consistently.

## Components

### Server

- `src/app/api/conversations/start/route.ts`
  - Creates a conversation for a topic.
  - Produces a short intro text based on the topic prompt/name.
  - Saves the intro as the first assistant message.
  - Returns `{ conversation, introMessage }`.

- `src/app/api/chat-voice/route.ts`
  - Requires the current topic/conversation context from the client when available.
  - Uses topic prompt resolution for the active conversation.
  - Persists the new user message and final assistant text to the database.
  - Updates `updatedAt` on each completed turn.

- `src/lib/conversation-intro.ts`
  - Pure helper to build/validate intro prompts and titles.
  - Small enough to test outside the route layer.

### Client

- `src/hooks/use-voice-chat.ts`
  - Adds a bootstrap conversation flow for topic selection.
  - Stores active topic/conversation ids in refs for request correctness.
  - Reuses `AudioStreamPlayer` for auto-speaking the intro.
  - Keeps interruption and replay-safe cleanup behavior.

- `src/app/page.tsx`
  - Starts the bootstrap flow when a topic is selected.

## Data Flow

### New topic flow

1. User selects topic.
2. Client calls `POST /api/conversations/start`.
3. Server creates conversation + intro message and returns both.
4. Client sets active conversation/topic state.
5. Client shows intro in message history.
6. Client speaks intro.
7. Client enters listening state.

### Normal turn flow

1. User speaks.
2. Client posts `messages`, `topicId`, and `conversationId` to `/api/chat-voice`.
3. Server resolves topic prompt from the active topic/conversation.
4. Server streams text/audio.
5. Server persists the user message and final assistant response.
6. Client updates the current conversation locally.

## Error Handling

- If bootstrap fails, show an inline error and do not enter listening mode.
- If intro speech fails, keep the intro text visible and still allow the user to talk.
- If `/api/chat-voice` fails after a bootstrap success, preserve the conversation and prior messages.
- If a topic id is invalid, the server should reject bootstrap instead of silently falling back.

## Testing Strategy

- Add a small pure helper module for intro generation and request-context decisions.
- Compile tests with `tsc` into a temporary output folder and run them with `node --test`.
- Cover:
  - topic-specific intro text includes the topic name/guidance,
  - generic fallbacks are not used when a valid topic is present,
  - request-context selection prefers the latest topic/conversation ids.

## Success Criteria

- DevTools request payload shows the chosen `topicId` instead of `null`.
- The first message in a new topic conversation is an assistant greeting.
- The greeting is spoken automatically.
- Reopening the conversation shows the greeting and later turns.
