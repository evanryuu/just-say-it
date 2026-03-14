'use client'

import { ChatState } from '@/hooks/use-voice-chat'

interface VoiceOrbProps {
  state: ChatState
  volume: number
  onClick: () => void
}

export function VoiceOrb({ state, volume, onClick }: VoiceOrbProps) {
  const isActive = state !== 'idle'

  // Scale the orb based on mic volume during listening
  const scale =
    state === 'listening'
      ? 1 + volume * 0.45
      : state === 'speaking'
        ? 1 // CSS animation handles this
        : 1

  const glowRadius = Math.round(20 + volume * 50)
  const glowOpacity = isActive ? 0.25 + volume * 0.3 : 0.1

  return (
    <div className="relative flex items-center justify-center select-none" style={{ width: 200, height: 200 }}>
      {/* Ripple rings (visible while listening) */}
      {state === 'listening' && volume > 0.05 && (
        <>
          <div
            className="absolute rounded-full bg-black/8 transition-all duration-75"
            style={{
              width: 200,
              height: 200,
              transform: `scale(${1 + volume * 0.6})`,
              opacity: volume * 0.6,
            }}
          />
          <div
            className="absolute rounded-full bg-black/12 transition-all duration-75"
            style={{
              width: 160,
              height: 160,
              transform: `scale(${1 + volume * 0.4})`,
              opacity: volume * 0.8,
            }}
          />
        </>
      )}

      {/* Main orb */}
      <div
        onClick={onClick}
        className={[
          'relative w-32 h-32 rounded-full bg-black cursor-pointer',
          'flex items-center justify-center',
          state === 'thinking' ? 'animate-pulse' : '',
          state === 'speaking' ? 'animate-breathe' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{
          transform: `scale(${scale})`,
          transition: state === 'listening' ? 'transform 80ms ease-out' : 'transform 400ms ease-in-out',
          boxShadow: `0 0 ${glowRadius}px rgba(0,0,0,${glowOpacity}), 0 8px 32px rgba(0,0,0,0.15)`,
        }}
        aria-label={state === 'idle' ? 'Start voice chat' : 'Stop voice chat'}
        role="button"
      >
        {/* Inner indicator dot */}
        <div
          className="rounded-full bg-white transition-all duration-300"
          style={{
            width: state === 'idle' ? 8 : 6,
            height: state === 'idle' ? 8 : 6,
            opacity: state === 'idle' ? 0.3 : 0.5,
          }}
        />
      </div>

      {/* Status label */}
      <div className="absolute -bottom-10 text-xs text-zinc-400 font-medium tracking-wide whitespace-nowrap">
        {state === 'idle' && 'Click to start'}
        {state === 'listening' && 'Listening…'}
        {state === 'thinking' && 'Thinking…'}
        {state === 'speaking' && 'Speaking…'}
      </div>
    </div>
  )
}
