import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

function resolveArkBaseUrl() {
  const raw = process.env.ARK_BASE_URL?.trim();
  const base = raw || 'https://ark.cn-beijing.volces.com/api/v3';
  return base.replace(/\/+$/, '');
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ARK_API_KEY) {
      return NextResponse.json(
        { error: 'Missing ARK_API_KEY in .env.local' },
        { status: 500 }
      );
    }
    if (!process.env.ARK_MODEL_ID) {
      return NextResponse.json(
        { error: 'Missing ARK_MODEL_ID in .env.local' },
        { status: 500 }
      );
    }

    const client = new OpenAI({
      apiKey: process.env.ARK_API_KEY,
      baseURL: resolveArkBaseUrl(),
    });

    const body = await req.json();
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: 'Invalid request: messages must be a non-empty array' },
        { status: 400 }
      );
    }

    const stream = await client.chat.completions.create({
      model: process.env.ARK_MODEL_ID,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful, conversational AI assistant. Keep responses concise and natural-sounding, as they will be spoken aloud. Respond in the same language the user speaks in.',
        },
        ...messages,
      ],
      stream: true,
      max_tokens: 500,
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta?.content ?? '';
            if (text) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ text })}\n\n`)
              );
            }
          }
        } finally {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error: unknown) {
    const status =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : 500;
    const message =
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : 'Unknown server error';
    const normalizedMessage = message.includes('<!DOCTYPE')
      ? 'Upstream API returned an HTML 404 page. Check ARK_BASE_URL and model endpoint compatibility.'
      : message;

    return NextResponse.json({ error: normalizedMessage }, { status });
  }
}
