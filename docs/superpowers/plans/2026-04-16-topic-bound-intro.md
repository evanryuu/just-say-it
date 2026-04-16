# Topic-Bound Intro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make topic selection reliably shape every conversation turn and automatically start each new topic with a persisted, spoken assistant greeting.

**Architecture:** Add a small server bootstrap endpoint for new topic conversations, move topic/conversation request context to explicit helper/ref-based flow, and persist intro plus turn messages in SQLite. Keep the existing `/api/chat-voice` SSE/TTS path for normal responses and reuse the audio player for intro playback.

**Tech Stack:** Next.js App Router, React hooks, TypeScript, better-sqlite3, Drizzle ORM, Node test runner via compiled TypeScript.

---

### Task 1: Add a lightweight test path and pure helper coverage

**Files:**
- Create: `src/lib/conversation-intro.ts`
- Create: `tests/conversation-intro.test.ts`
- Create: `tsconfig.test.json`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Add tests for:
- intro text includes the selected topic name,
- intro text gives the user a guided next step,
- request context returns the latest non-null topic/conversation ids.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL because helper module or exports do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement small pure helpers for:
- building a short intro from a topic,
- deriving the active request context from ref/state values.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS

### Task 2: Add conversation bootstrap endpoint

**Files:**
- Create: `src/app/api/conversations/start/route.ts`
- Modify: `src/db/index.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/app/api/conversations/route.ts`

- [ ] **Step 1: Write the failing test**

Extend helper-level coverage for bootstrap inputs if needed, especially invalid topic rejection and intro title shaping.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL on missing validation or helper behavior.

- [ ] **Step 3: Write minimal implementation**

Create a route that:
- validates `topicId`,
- creates the conversation,
- saves the intro assistant message,
- returns `{ conversation, introMessage }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS

### Task 3: Fix client state flow and auto-play the intro

**Files:**
- Modify: `src/hooks/use-voice-chat.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/components/topic-select-modal.tsx`

- [ ] **Step 1: Write the failing test**

Add/extend helper tests for latest request-context selection and intro message normalization.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL if stale-state behavior is still encoded in helpers.

- [ ] **Step 3: Write minimal implementation**

Update the hook so topic selection:
- bootstraps a conversation,
- stores topic/conversation ids in refs and state,
- appends the intro message,
- speaks the intro automatically,
- returns to listening mode after intro playback.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS

### Task 4: Persist normal chat turns and keep history coherent

**Files:**
- Modify: `src/app/api/chat-voice/route.ts`
- Modify: `src/app/api/conversations/[id]/messages/route.ts`
- Modify: `src/components/history-sidebar.tsx`

- [ ] **Step 1: Write the failing test**

Add helper coverage for message persistence shaping if extracted.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL for missing helper behavior.

- [ ] **Step 3: Write minimal implementation**

Persist:
- the current user message at turn start,
- the final assistant text at turn completion,
- `updatedAt` on the conversation.

Also fix the sidebar render-time `Date.now()` lint issue with a stable timestamp strategy.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS

### Task 5: Verify the full behavior

**Files:**
- Modify: `docs/plan.md`

- [ ] **Step 1: Run targeted verification**

Run:
- `pnpm test`
- `pnpm lint`
- `pnpm build`

Expected:
- tests pass,
- no new lint errors from changed files,
- production build succeeds.

- [ ] **Step 2: Update plan status**

Mark Phase 2 in `docs/plan.md` as in progress and note the new intro/topic-binding work.

- [ ] **Step 3: Summarize behavior**

Capture:
- how topic bootstrap works,
- how intro persistence works,
- remaining follow-up items if any.
