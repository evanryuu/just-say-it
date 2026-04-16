'use client';

import { useState } from 'react';
import { Topic } from '@/hooks/use-voice-chat';
import { X, Plus } from 'lucide-react';

interface TopicSelectModalProps {
  topics: Topic[];
  onSelect: (topic: Topic) => void;
  onClose: () => void;
}

export function TopicSelectModal({ topics, onSelect, onClose }: TopicSelectModalProps) {
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreateCustom = async () => {
    if (!customName.trim() || !customPrompt.trim()) {
      setError('Name and prompt are required');
      return;
    }
    setIsCreating(true);
    setError('');
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: customName.trim(), systemPrompt: customPrompt.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to create topic');
        return;
      }
      const created: Topic = await res.json();
      onSelect(created);
    } catch {
      setError('Network error');
    } finally {
      setIsCreating(false);
    }
  };

  const presetTopics = topics.filter((t) => !t.isCustom);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Sheet */}
      <div className="relative bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-6 shadow-xl max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-zinc-900">Choose a topic</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-zinc-100 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-zinc-500" />
          </button>
        </div>

        {/* Topic grid */}
        {!showCustomForm ? (
          <div className="grid grid-cols-2 gap-3">
            {presetTopics.map((topic) => (
              <button
                key={topic.id}
                onClick={() => onSelect(topic)}
                className="flex flex-col items-start gap-2 p-4 rounded-xl border border-zinc-200 hover:border-zinc-400 hover:bg-zinc-50 transition-all text-left"
              >
                <span className="text-2xl">{topic.icon}</span>
                <span className="text-sm font-medium text-zinc-800">{topic.name}</span>
              </button>
            ))}

            {/* Custom card */}
            <button
              onClick={() => setShowCustomForm(true)}
              className="flex flex-col items-start gap-2 p-4 rounded-xl border border-dashed border-zinc-300 hover:border-zinc-400 hover:bg-zinc-50 transition-all text-left"
            >
              <Plus className="w-6 h-6 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-500">Custom</span>
            </button>
          </div>
        ) : (
          /* Custom form */
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">
                Topic name
              </label>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Cooking, Fitness..."
                className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">
                System prompt
              </label>
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Describe how the AI should behave in this conversation..."
                rows={4}
                className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 resize-none"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setShowCustomForm(false)}
                className="flex-1 px-4 py-2 border border-zinc-300 rounded-lg text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleCreateCustom}
                disabled={isCreating}
                className="flex-1 px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-zinc-800 transition-colors disabled:opacity-50"
              >
                {isCreating ? 'Creating...' : 'Create & Start'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
