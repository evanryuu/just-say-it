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
    const audioChunks: Buffer[] = [];

    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        audioChunks.push(Buffer.from(chunk.data));
      }
    }

    if (audioChunks.length === 0) {
      return NextResponse.json(
        { error: 'TTS produced no audio' },
        { status: 500 }
      );
    }

    const audioBuffer = Buffer.concat(audioChunks);

    return new Response(audioBuffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audioBuffer.byteLength),
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (error: unknown) {
    console.error('TTS error:', error);
    const message =
      error instanceof Error ? error.message : 'Unknown TTS error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
