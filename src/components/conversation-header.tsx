'use client';

import { Topic } from '@/hooks/use-voice-chat';
import { ChevronLeft } from 'lucide-react';

interface ConversationHeaderProps {
  topic: Topic | null;
  title: string;
  onBack: () => void;
}

export function ConversationHeader({ topic, title, onBack }: ConversationHeaderProps) {
  if (!topic) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100 bg-white">
      <button
        onClick={onBack}
        className="p-1.5 rounded-full hover:bg-zinc-100 transition-colors"
        aria-label="Back to topic selection"
      >
        <ChevronLeft className="w-4 h-4 text-zinc-500" />
      </button>
      <span className="text-lg">{topic.icon}</span>
      <span className="text-sm font-medium text-zinc-700 truncate">{title}</span>
    </div>
  );
}
