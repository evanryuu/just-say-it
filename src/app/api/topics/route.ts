import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function GET() {
  const topics = db.select().from(schema.topics).all();
  return NextResponse.json(topics);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, systemPrompt, icon = '✨' } = body;

  if (!name || !systemPrompt) {
    return NextResponse.json({ error: 'name and systemPrompt required' }, { status: 400 });
  }

  const id = `custom-${Date.now()}`;
  db.insert(schema.topics)
    .values({
      id,
      name,
      icon,
      systemPrompt,
      isCustom: true,
      createdAt: new Date(),
    })
    .run();

  const [created] = db.select().from(schema.topics).where(eq(schema.topics.id, id)).all();
  return NextResponse.json(created, { status: 201 });
}
