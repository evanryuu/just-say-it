import { db, schema } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const topicId = searchParams.get('topicId');

  let rows;
  if (topicId) {
    rows = db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.topicId, topicId))
      .orderBy(desc(schema.conversations.updatedAt))
      .all();
  } else {
    rows = db
      .select()
      .from(schema.conversations)
      .orderBy(desc(schema.conversations.updatedAt))
      .all();
  }

  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { topicId, title } = body;

  if (!topicId) {
    return NextResponse.json({ error: 'topicId required' }, { status: 400 });
  }

  const id = `conv-${Date.now()}`;
  const finalTitle = title || 'New conversation';

  db.insert(schema.conversations)
    .values({
      id,
      topicId,
      title: finalTitle,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();

  const [created] = db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).all();
  return NextResponse.json(created, { status: 201 });
}
