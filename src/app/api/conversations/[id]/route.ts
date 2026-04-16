import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [conversation] = db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, id))
    .all();

  if (!conversation) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const topic = db
    .select()
    .from(schema.topics)
    .where(eq(schema.topics.id, conversation.topicId))
    .all()[0];

  return NextResponse.json({ ...conversation, topic });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { title } = body;

  const existing = db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, id))
    .all()[0];

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  db.update(schema.conversations)
    .set({
      ...(title !== undefined && { title }),
      updatedAt: new Date(),
    })
    .where(eq(schema.conversations.id, id))
    .run();

  const [updated] = db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, id))
    .all();

  return NextResponse.json(updated);
}
