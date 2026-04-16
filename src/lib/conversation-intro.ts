export interface IntroTopic {
  id: string;
  name: string;
}

export interface ConversationRequestContextInput {
  topicId: string | null;
  conversationId: string | null;
  latestTopicId?: string | null;
  latestConversationId?: string | null;
}

const TOPIC_GUIDE_BY_ID: Record<string, string> = {
  'lang-learning': 'We can practice simple conversation, vocabulary, or short speaking drills.',
  travelling: 'We can talk about destinations, useful phrases, or travel planning.',
  anime: 'We can talk about favorite series, characters, or what to watch next.',
  gaming: 'We can chat about the games you are playing, strategy, or new recommendations.',
};

export function buildTopicIntro(topic: IntroTopic): string {
  const topicName = topic.name.trim() || 'this topic';
  const guide =
    TOPIC_GUIDE_BY_ID[topic.id] ??
    `We can talk about ${topicName.toLowerCase()} and anything around it.`;

  return `Hi! Welcome to ${topicName}. ${guide} Tell me what you want to talk about first.`;
}

export function buildConversationTitle(topic: IntroTopic): string {
  const topicName = topic.name.trim() || 'Conversation';
  return `${topicName} chat`;
}

export function resolveConversationRequestContext(
  input: ConversationRequestContextInput,
): { topicId: string | null; conversationId: string | null } {
  return {
    topicId: input.latestTopicId ?? input.topicId,
    conversationId: input.latestConversationId ?? input.conversationId,
  };
}
