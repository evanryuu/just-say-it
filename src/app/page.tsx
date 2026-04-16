'use client';

import { useEffect, useRef, useState } from 'react';
import { useVoiceChat, Topic } from '@/hooks/use-voice-chat';
import { VoiceOrb } from '@/components/voice-orb';
import { TopicSelectModal } from '@/components/topic-select-modal';
import { HistorySidebar } from '@/components/history-sidebar';
import { ConversationHeader } from '@/components/conversation-header';
import { Menu, Plus } from 'lucide-react';

export default function Home() {
  const {
    state,
    volume,
    messages,
    interimText,
    errorMessage,
    currentTopic,
    topics,
    startChat,
    resumeChat,
    stopChat,
    loadTopics,
    loadConversation,
    startNewChat,
  } = useVoiceChat();

  const [showTopicModal, setShowTopicModal] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleOrbClick = () => {
    if (state === 'idle') {
      if (currentTopic) {
        void resumeChat();
      } else {
        setShowTopicModal(true);
      }
    } else {
      stopChat();
    }
  };

  const handleTopicSelect = (topic: Topic) => {
    setShowTopicModal(false);
    void startChat(topic);
  };

  const handleSelectConversation = (convId: string) => {
    stopChat();
    loadConversation(convId);
  };

  const handleNewChat = () => {
    startNewChat();
    setShowTopicModal(true);
  };

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
        <button
          onClick={() => setShowSidebar(true)}
          className="p-2 rounded-lg hover:bg-zinc-100 transition-colors"
          aria-label="Open history"
        >
          <Menu className="w-5 h-5 text-zinc-600" />
        </button>

        <div className="flex items-center gap-2 min-w-0">
          {currentTopic ? (
            <>
              <span className="text-base">{currentTopic.icon}</span>
              <span className="text-sm font-medium text-zinc-700 truncate">{currentTopic.name}</span>
            </>
          ) : (
            <span className="text-sm text-zinc-400">Select a topic to start</span>
          )}
        </div>

        <button
          onClick={() => setShowTopicModal(true)}
          className="p-2 rounded-lg hover:bg-zinc-100 transition-colors"
          aria-label="New chat"
        >
          <Plus className="w-5 h-5 text-zinc-600" />
        </button>
      </div>

      {/* Conversation header (when topic active) */}
      {currentTopic && messages.length > 0 && (
        <ConversationHeader
          topic={currentTopic}
          title={messages[0]?.content?.slice(0, 30) + (messages[0]?.content?.length > 30 ? '…' : '') || 'Conversation'}
          onBack={startNewChat}
        />
      )}

      {/* Orb area */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        {currentTopic && (
          <div className="flex items-center gap-2 px-4 py-2 bg-zinc-50 rounded-full">
            <span className="text-lg">{currentTopic.icon}</span>
            <span className="text-sm font-medium text-zinc-700">{currentTopic.name}</span>
          </div>
        )}
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

      {/* Topic selection modal */}
      {showTopicModal && (
        <TopicSelectModal
          topics={topics}
          onSelect={handleTopicSelect}
          onClose={() => setShowTopicModal(false)}
        />
      )}

      {/* History sidebar */}
      {showSidebar && (
        <HistorySidebar
          onClose={() => setShowSidebar(false)}
          onSelectConversation={handleSelectConversation}
          onNewChat={handleNewChat}
        />
      )}
    </div>
  );
}
