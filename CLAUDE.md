# Just Say It

Voice-based AI chat app. Users speak → speech is transcribed → sent to AI (VolcEngine ARK / Doubao LLM) → response is spoken back via TTS.

## Commands

- `pnpm dev` — start dev server
- `pnpm build` — production build
- `pnpm lint` — run eslint

## Tech Stack

- Next.js 16 (App Router), React 19, TypeScript 5
- Tailwind CSS 4, shadcn/ui, Radix UI, Lucide icons
- OpenAI SDK targeting VolcEngine ARK API
- VolcEngine bidirectional WebSocket TTS (server-side, via `ws`)
- Web Speech API (recognition only), Web Audio API (volume analysis)
- MediaSource API (gapless client-side audio streaming)

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── chat-voice/route.ts  # Main endpoint: LLM + TTS merged SSE stream
│   │   └── chat/route.ts        # Text-only LLM streaming (no TTS)
│   ├── page.tsx                 # Main UI: message display + VoiceOrb
│   ├── layout.tsx               # Root layout with fonts (Geist, Inter)
│   └── globals.css              # Global styles + animations
├── components/
│   ├── ui/button.tsx            # shadcn Button component
│   └── voice-orb.tsx            # Animated sphere for voice interaction
├── hooks/
│   └── use-voice-chat.ts        # Core logic: mic, STT, API streaming, playback
├── lib/
│   ├── tts/
│   │   ├── types.ts             # TtsProvider interface, capabilities, TtsStallError
│   │   ├── volc.ts              # VolcEngine V3 bidirectional WebSocket adapter
│   │   ├── minimax.ts           # Minimax t2a_v2 WebSocket adapter
│   │   └── index.ts             # createTtsProvider() factory (TTS_PROVIDER env)
│   ├── audio-stream-player.ts   # Gapless MP3 playback via MediaSource + SourceBuffer
│   └── utils.ts                 # cn() helper (clsx + tailwind-merge)
└── types/
    └── speech.d.ts              # Web Speech API type definitions
```

## Key Concepts

- **State flow:** `idle → listening → thinking → speaking`
- **Barge-in:** User can interrupt AI speech (1500ms grace period after playback starts)
- **Volume visualization:** 60fps via requestAnimationFrame + Web Audio API
- **Streaming:** `/api/chat-voice` returns SSE with interleaved `{"type":"text"}` and `{"type":"audio"}` events
- **TTS pipeline:** LLM tokens fed directly to VolcEngine WebSocket as they arrive; VolcEngine handles sentence splitting internally
- **Audio playback:** MP3 chunks appended to MediaSource SourceBuffer for gapless streaming
- **Multi-turn:** Conversation history sent with each request

## Environment

Requires `.env.local` with:
- `ARK_API_KEY` — VolcEngine ARK API credential
- `ARK_BASE_URL` — ARK endpoint (default: cn-beijing region)
- `ARK_MODEL_ID` — Doubao model endpoint ID
- `TTS_PROVIDER` — `volc` (default) or `minimax`
- Volc: `VOLC_TTS_APPID`, `VOLC_TTS_ACCESS_TOKEN`, `VOLC_TTS_RESOURCE_ID`, `VOLC_TTS_SPEAKER`
- Minimax: `MINIMAX_API_KEY`, `MINIMAX_TTS_MODEL`, `MINIMAX_TTS_VOICE_ID`, optional `MINIMAX_TTS_EMOTION`, `MINIMAX_TTS_LANGUAGE_BOOST`, `MINIMAX_TTS_SAMPLE_RATE`

## Path Aliases

`@/*` → `./src/*` (configured in tsconfig.json)
