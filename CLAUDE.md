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
- Web Speech API (recognition + synthesis), Web Audio API (volume analysis)

## Architecture

```
src/
├── app/
│   ├── api/chat/route.ts    # Streaming chat endpoint (SSE via OpenAI SDK → ARK)
│   ├── page.tsx             # Main UI: message display + VoiceOrb
│   ├── layout.tsx           # Root layout with fonts (Geist, Inter)
│   └── globals.css          # Global styles + animations
├── components/
│   ├── ui/button.tsx        # shadcn Button component
│   └── voice-orb.tsx        # Animated sphere for voice interaction
├── hooks/
│   └── use-voice-chat.ts    # Core logic: mic, speech recognition, API, TTS
├── lib/
│   └── utils.ts             # cn() helper (clsx + tailwind-merge)
└── types/
    └── speech.d.ts          # Web Speech API type definitions
```

## Key Concepts

- **State flow:** `idle → listening → thinking → speaking`
- **Barge-in:** User can interrupt AI speech (700ms debounce grace period)
- **Volume visualization:** 60fps via requestAnimationFrame + Web Audio API
- **Streaming:** API returns SSE stream, response accumulated on client
- **Multi-turn:** Conversation history sent with each request

## Environment

Requires `.env.local` with:
- `ARK_API_KEY` — VolcEngine ARK API credential
- `ARK_BASE_URL` — ARK endpoint (default: cn-beijing region)
- `ARK_MODEL_ID` — Doubao model endpoint ID

## Path Aliases

`@/*` → `./src/*` (configured in tsconfig.json)
