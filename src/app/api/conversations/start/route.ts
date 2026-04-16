import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { buildConversationTitle, buildTopicIntro } from '@/lib/conversation-intro';
import { createTtsProvider } from '@/lib/tts';
import { db, schema } from '@/db';

async function synthesizeIntroAudio(text: string): Promise<string | null> {
  let tts;

  try {
    tts = createTtsProvider();
  } catch {
    return null;
  }

  const chunks: Buffer[] = [];

  try {
    await tts.connect();

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (cb: () => void) => {
        if (settled) return;
        settled = true;
        cb();
      };

      tts
        .startSession({
          onAudio: (chunk) => {
            chunks.push(chunk);
          },
          onFinished: () => {
            finish(resolve);
          },
          onError: (error) => {
            finish(() => reject(error));
          },
        })
        .then(() => {
          tts.sendText(text);
          tts.finishSession();
        })
        .catch((error) => {
          finish(() => reject(error));
        });
    });
  } catch (error) {
    console.error('intro audio synthesis failed:', error);
    return null;
  } finally {
    tts.close();
  }

  if (chunks.length === 0) {
    return null;
  }

  return Buffer.concat(chunks).toString('base64');
}

export async function POST(request: Request) {
  const body = await request.json();
  const topicId = typeof body?.topicId === 'string' ? body.topicId : null;

  if (!topicId) {
    return NextResponse.json({ error: 'topicId required' }, { status: 400 });
  }

  const [topic] = db
    .select()
    .from(schema.topics)
    .where(eq(schema.topics.id, topicId))
    .all();

  if (!topic) {
    return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
  }

  const now = new Date();
  const conversationId = `conv-${Date.now()}`;
  const introText = buildTopicIntro(topic);
  const title = buildConversationTitle(topic);

  db.insert(schema.conversations)
    .values({
      id: conversationId,
      topicId: topic.id,
      title,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const introMessage = {
    id: `msg-${Date.now()}`,
    conversationId,
    role: 'assistant' as const,
    content: introText,
    createdAt: now,
  };

  db.insert(schema.messages).values(introMessage).run();

  const introAudioBase64 = await synthesizeIntroAudio(introText);

  return NextResponse.json({
    conversation: {
      id: conversationId,
      topicId: topic.id,
      title,
      createdAt: now,
      updatedAt: now,
    },
    introMessage,
    introAudioBase64,
  });
}
