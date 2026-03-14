import { NextRequest, NextResponse } from 'next/server';
import { Communicate } from 'edge-tts-universal';
import { getVoiceForLang } from '@/lib/tts-voices';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = body?.text;
    const voice = body?.voice as string | undefined;
    const lang = body?.lang as string | undefined;

    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "text" field' },
        { status: 400 }
      );
    }

    const selectedVoice = voice || getVoiceForLang(lang);
    const communicate = new Communicate(text, { voice: selectedVoice });

    // Stream audio chunks as they arrive instead of buffering everything
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of communicate.stream()) {
            if (chunk.type === 'audio' && chunk.data) {
              controller.enqueue(new Uint8Array(chunk.data));
            }
          }
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.close();
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error: unknown) {
    console.error('TTS error:', error);
    const message =
      error instanceof Error ? error.message : 'Unknown TTS error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
