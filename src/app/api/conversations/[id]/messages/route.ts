import { db, schema } from '@/db';
import { eq, asc } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rows = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, id))
    .orderBy(asc(schema.messages.createdAt))
    .all();

  return NextResponse.json(rows);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { role, content } = body;

  if (!role || !content) {
    return NextResponse.json({ error: 'role and content required' }, { status: 400 });
  }

  if (role !== 'user' && role !== 'assistant') {
    return NextResponse.json({ error: 'role must be user or assistant' }, { status: 400 });
  }

  const messageId = `msg-${Date.now()}`;
  db.insert(schema.messages)
    .values({
      id: messageId,
      conversationId: id,
      role,
      content,
      createdAt: new Date(),
    })
    .run();

  // Update conversation updatedAt
  db.update(schema.conversations)
    .set({ updatedAt: new Date() })
    .where(eq(schema.conversations.id, id))
    .run();

  const [created] = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .all();

  return NextResponse.json(created, { status: 201 });
}
