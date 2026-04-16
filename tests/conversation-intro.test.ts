import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConversationTitle,
  buildTopicIntro,
  resolveConversationRequestContext,
} from '../src/lib/conversation-intro';

test('buildTopicIntro includes the selected topic name and guidance', () => {
  const intro = buildTopicIntro({ id: 'anime', name: 'Anime' });

  assert.match(intro, /Anime/);
  assert.match(intro, /favorite series|characters|watch next/);
  assert.match(intro, /what you want to talk about first/i);
});

test('buildConversationTitle uses the topic name', () => {
  assert.equal(
    buildConversationTitle({ id: 'anime', name: 'Anime' }),
    'Anime chat',
  );
});

test('resolveConversationRequestContext prefers the latest non-null ids', () => {
  assert.deepEqual(
    resolveConversationRequestContext({
      topicId: null,
      conversationId: null,
      latestTopicId: 'anime',
      latestConversationId: 'conv-123',
    }),
    { topicId: 'anime', conversationId: 'conv-123' },
  );
});
