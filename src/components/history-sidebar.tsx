'use client';

import { useEffect, useState } from 'react';
import { Topic } from '@/hooks/use-voice-chat';
import { X, MessageSquare } from 'lucide-react';

interface ConversationSummary {
  id: string;
  topicId: string;
  title: string;
  updatedAt: string;
}

interface HistorySidebarProps {
  onClose: () => void;
  onSelectConversation: (convId: string) => void;
  onNewChat: () => void;
}

export function HistorySidebar({ onClose, onSelectConversation, onNewChat }: HistorySidebarProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [relativeNow, setRelativeNow] = useState(() => Date.now());

  useEffect(() => {
    Promise.all([fetch('/api/conversations').then((r) => r.json()), fetch('/api/topics').then((r) => r.json())]).then(
      ([convs, tops]) => {
        setConversations(convs);
        setTopics(tops);
        setRelativeNow(Date.now());
        setLoading(false);
      }
    );
  }, []);

  const topicMap = Object.fromEntries(topics.map((t) => [t.id, t]));

  // Group by topic
  const byTopic = conversations.reduce<Record<string, ConversationSummary[]>>((acc, conv) => {
    if (!acc[conv.topicId]) acc[conv.topicId] = [];
    acc[conv.topicId].push(conv);
    return acc;
  }, {});

  const formatRelative = (iso: string) => {
    const diff = relativeNow - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed left-0 top-0 bottom-0 w-72 bg-white z-50 shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-100">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">History</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-zinc-100 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-zinc-500" />
          </button>
        </div>

        {/* New chat */}
        <div className="p-3 border-b border-zinc-100">
          <button
            onClick={() => {
              onNewChat();
              onClose();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors"
          >
            <MessageSquare className="w-4 h-4" />
            New Chat
          </button>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-sm text-zinc-400">Loading...</div>
          ) : conversations.length === 0 ? (
            <div className="p-4 text-sm text-zinc-400">No conversations yet</div>
          ) : (
            Object.entries(byTopic).map(([topicId, convs]) => {
              const topic = topicMap[topicId];
              return (
                <div key={topicId}>
                  {/* Topic header */}
                  <div className="flex items-center gap-1.5 px-4 py-2 bg-zinc-50 sticky top-0">
                    <span className="text-sm">{topic?.icon ?? '💬'}</span>
                    <span className="text-xs font-medium text-zinc-500">{topic?.name ?? topicId}</span>
                  </div>
                  {/* Conversations under topic */}
                  {convs.map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => {
                        onSelectConversation(conv.id);
                        onClose();
                      }}
                      className="w-full text-left px-4 py-3 hover:bg-zinc-50 border-b border-zinc-100 transition-colors"
                    >
                      <p className="text-sm text-zinc-800 font-medium truncate">{conv.title}</p>
                      <p className="text-xs text-zinc-400 mt-0.5">{formatRelative(conv.updatedAt)}</p>
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
