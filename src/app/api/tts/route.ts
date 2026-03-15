import { NextRequest, NextResponse } from 'next/server';

const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();

    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "text" field' },
        { status: 400 }
      );
    }

    const appId = process.env.VOLC_TTS_APPID;
    const accessKey = process.env.VOLC_TTS_ACCESS_TOKEN;
    const resourceId = process.env.VOLC_TTS_RESOURCE_ID || 'seed-tts-2.0';
    const speaker = process.env.VOLC_TTS_SPEAKER || 'zh_female_cancan_mars_bigtts';

    if (!appId || !accessKey) {
      return NextResponse.json(
        { error: 'Missing VOLC_TTS_APPID or VOLC_TTS_ACCESS_TOKEN in .env.local' },
        { status: 500 }
      );
    }

    const payload = {
      user: { uid: 'web-user' },
      req_params: {
        text,
        speaker,
        audio_params: {
          format: 'mp3',
          sample_rate: 24000,
          speech_rate: 15,
        },
        // context_texts guides the TTS model's tone/emotion (seed-tts-2.0 only)
        context_texts: ['Please speak in a warm, friendly, and conversational tone.'],
      },
    };

    const upstream = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'X-Api-App-Id': appId,
        'X-Api-Access-Key': accessKey,
        'X-Api-Resource-Id': resourceId,
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const msg = await upstream.text();
      console.error('VolcEngine TTS error:', upstream.status, msg);
      return NextResponse.json(
        { error: `TTS upstream error (${upstream.status})` },
        { status: 502 }
      );
    }

    // The upstream returns line-delimited JSON.
    // Each line: {"code":0,"data":"<base64 mp3 chunk>"}
    // Final line: {"code":20000000} = done
    // We decode base64 and stream raw mp3 bytes to the client.
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let leftover = '';

    const readable = new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Process any remaining data in leftover
            if (leftover.trim()) {
              processLine(leftover, controller);
            }
            controller.close();
            return;
          }

          leftover += decoder.decode(value, { stream: true });
          const lines = leftover.split('\n');
          leftover = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            const shouldStop = processLine(line, controller);
            if (shouldStop) {
              controller.close();
              return;
            }
          }
        }
      },
      cancel() {
        reader.cancel();
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'audio/mpeg',
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

/** Returns true if the stream should stop. */
function processLine(
  line: string,
  controller: ReadableStreamDefaultController
): boolean {
  try {
    const data = JSON.parse(line);

    // Audio chunk
    if (data.code === 0 && data.data) {
      const bytes = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0));
      controller.enqueue(bytes);
      return false;
    }

    // Completion
    if (data.code === 20000000) {
      return true;
    }

    // Error
    if (data.code > 0 && data.code !== 20000000) {
      console.error('VolcEngine TTS stream error:', data);
      return true;
    }
  } catch {
    // Skip malformed lines
  }
  return false;
}
