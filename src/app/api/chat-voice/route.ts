/**
 * Merged LLM + TTS streaming endpoint.
 *
 * Client sends: POST { messages }
 * Server returns: SSE stream with two event types:
 *   data: {"type":"text","delta":"..."}     — LLM text token
 *   data: {"type":"audio","data":"base64"}  — MP3 audio chunk
 *   data: [DONE]
 *
 * Server-side flow:
 *   1. Stream LLM response via OpenAI SDK (→ ARK)
 *   2. Feed each LLM token into VolcEngine bidirectional WebSocket
 *   3. VolcEngine handles sentence splitting internally
 *   4. Audio chunks stream back and are base64-encoded into the SSE response
 */

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { VolcTtsWs, type VolcTtsConfig } from '@/lib/volc-tts-ws';

function resolveArkBaseUrl() {
  const raw = process.env.ARK_BASE_URL?.trim();
  const base = raw || 'https://ark.cn-beijing.volces.com/api/v3';
  return base.replace(/\/+$/, '');
}

function getTtsConfig(): VolcTtsConfig {
  const appId = process.env.VOLC_TTS_APPID;
  const accessKey = process.env.VOLC_TTS_ACCESS_TOKEN;
  if (!appId || !accessKey) {
    throw new Error('Missing VOLC_TTS_APPID or VOLC_TTS_ACCESS_TOKEN');
  }
  return {
    appId,
    accessKey,
    resourceId: process.env.VOLC_TTS_RESOURCE_ID || 'seed-tts-2.0',
    speaker: process.env.VOLC_TTS_SPEAKER || 'zh_female_cancan_mars_bigtts',
    format: 'mp3',
    sampleRate: 24000,
    speechRate: 0,
    contextTexts: [
      'Please speak in a warm, friendly, and conversational tone.',
    ],
  };
}

export async function POST(req: NextRequest) {
  try {
    // Validate env
    if (!process.env.ARK_API_KEY) {
      return NextResponse.json(
        { error: 'Missing ARK_API_KEY in .env.local' },
        { status: 500 },
      );
    }
    if (!process.env.ARK_MODEL_ID) {
      return NextResponse.json(
        { error: 'Missing ARK_MODEL_ID in .env.local' },
        { status: 500 },
      );
    }

    let ttsConfig: VolcTtsConfig;
    try {
      ttsConfig = getTtsConfig();
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'TTS config error' },
        { status: 500 },
      );
    }

    const body = await req.json();
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: 'Invalid request: messages must be a non-empty array' },
        { status: 400 },
      );
    }

    const client = new OpenAI({
      apiKey: process.env.ARK_API_KEY,
      baseURL: resolveArkBaseUrl(),
    });

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        const tts = new VolcTtsWs(ttsConfig);
        let ttsSessionActive = false;
        let llmDone = false;
        let closed = false;

        const enqueue = (data: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } catch {
            closed = true;
          }
        };

        const cleanup = () => {
          if (ttsSessionActive) {
            tts.cancelSession();
            ttsSessionActive = false;
          }
          tts.close();
        };

        const finish = () => {
          if (closed) return;
          closed = true;
          enqueue('[DONE]');
          try {
            controller.close();
          } catch {}
          cleanup();
        };

        try {
          // 1. Start TTS setup and LLM stream in parallel to reduce time-to-first-token
          const ttsSetup = tts.connect().then(() =>
            tts.startSession({
              onAudio: (chunk) => {
                enqueue(
                  JSON.stringify({
                    type: 'audio',
                    data: chunk.toString('base64'),
                  }),
                );
              },
              onFinished: () => {
                ttsSessionActive = false;
                finish();
              },
              onError: (err) => {
                console.error('TTS session error:', err);
                ttsSessionActive = false;
                if (llmDone) finish();
              },
            }),
          );

          // Track TTS readiness via flag (set by resolved promise callback)
          let ttsReady = false;
          let ttsFailed = false;
          ttsSetup
            .then(() => {
              ttsSessionActive = true;
              ttsReady = true;
            })
            .catch(() => {
              ttsFailed = true;
            });

          const stream = await client.chat.completions.create({
            model: process.env.ARK_MODEL_ID!,
            messages: [
              {
                role: 'system',
                content:
                  'You are a voice assistant. Your responses will be spoken aloud, so keep them SHORT — 1 to 3 sentences max. Answer directly without preamble, lists, or elaboration. If the topic is complex, give the core answer first and offer to explain more. Respond in the same language the user speaks in.',
              },
              ...messages,
            ],
            stream: true,
            max_tokens: 150,
          });

          // 2. Stream LLM tokens, feeding to TTS as soon as it's ready
          const pendingTexts: string[] = [];

          for await (const chunk of stream) {
            if (closed) break;
            const text = chunk.choices[0]?.delta?.content ?? '';
            if (text) {
              enqueue(JSON.stringify({ type: 'text', delta: text }));
              if (ttsReady && ttsSessionActive) {
                // TTS is ready — also flush any buffered tokens first
                if (pendingTexts.length > 0) {
                  tts.sendText(pendingTexts.join(''));
                  pendingTexts.length = 0;
                }
                tts.sendText(text);
              } else if (!ttsFailed) {
                pendingTexts.push(text);
              }
            }
          }

          llmDone = true;

          // 3. If TTS wasn't ready during streaming, wait for it now
          if (!ttsReady && !ttsFailed) {
            try {
              await ttsSetup;
              ttsSessionActive = true;
              ttsReady = true;
            } catch {
              ttsFailed = true;
            }
          }

          if (ttsFailed) {
            finish();
            return;
          }

          // 4. Flush any remaining buffered tokens and finish TTS
          if (pendingTexts.length > 0) {
            tts.sendText(pendingTexts.join(''));
            pendingTexts.length = 0;
          }

          if (ttsSessionActive) {
            tts.finishSession();
          } else {
            finish();
          }
        } catch (error) {
          console.error('chat-voice error:', error);
          if (!closed) {
            const message =
              error instanceof Error ? error.message : 'Unknown error';
            enqueue(JSON.stringify({ type: 'error', message }));
            closed = true;
            try {
              controller.close();
            } catch {}
          }
          cleanup();
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
    return NextResponse.json({ error: message }, { status });
  }
}
