'use client'

import { useEffect, useRef } from 'react'
import { useVoiceChat } from '@/hooks/use-voice-chat'
import { VoiceOrb } from '@/components/voice-orb'

export default function Home() {
  const { state, volume, messages, interimText, errorMessage, startChat, stopChat } = useVoiceChat()

  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleOrbClick = () => {
    if (state === 'idle') {
      startChat()
    } else {
      stopChat()
    }
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Orb area */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        <VoiceOrb state={state} volume={volume} onClick={handleOrbClick} />

        {/* Interim transcript */}
        {interimText && (
          <p className="mt-4 text-sm text-zinc-400 italic max-w-xs text-center leading-relaxed">
            &ldquo;{interimText}&rdquo;
          </p>
        )}

        {errorMessage && (
          <p className="mt-2 text-sm text-red-600 max-w-md text-center leading-relaxed">
            {errorMessage}
          </p>
        )}
      </div>

      {/* Conversation history */}
      {messages.length > 0 && (
        <div className="border-t border-zinc-100 max-h-60 overflow-y-auto">
          <div className="max-w-xl mx-auto px-4 py-4 space-y-3">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={[
                    'rounded-2xl px-4 py-2 max-w-xs text-sm leading-relaxed',
                    msg.role === 'user'
                      ? 'bg-black text-white rounded-br-sm'
                      : 'bg-zinc-100 text-zinc-800 rounded-bl-sm',
                  ].join(' ')}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}
