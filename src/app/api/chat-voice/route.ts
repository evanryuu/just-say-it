/**
 * Merged LLM + TTS streaming endpoint.
 *
 * Client sends: POST { messages }
 * Server returns: SSE stream with two event types:
 *   data: {"type":"text","delta":"..."}     — LLM text token
 *   data: {"type":"audio","data":"base64"}  — MP3 audio chunk
 *   data: [DONE]
 *
 * TTS provider (Volc or Minimax) is selected via TTS_PROVIDER env var.
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import OpenAI from 'openai';

import { buildConversationTitle } from '@/lib/conversation-intro';
import { createTtsProvider, TtsStallError } from '@/lib/tts';
import { db, schema } from '@/db';

function resolveArkBaseUrl() {
  const raw = process.env.ARK_BASE_URL?.trim();
  const base = raw || 'https://ark.cn-beijing.volces.com/api/v3';
  return base.replace(/\/+$/, '');
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

    let tts;
    try {
      tts = createTtsProvider();
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'TTS config error' },
        { status: 500 },
      );
    }

    const body = await req.json();
    const messages = body?.messages;
    const requestedTopicId = body?.topicId;
    const requestConversationId = body?.conversationId;

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: 'Invalid request: messages must be a non-empty array' },
        { status: 400 },
      );
    }

    const [conversation] = requestConversationId
      ? db
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.id, requestConversationId))
          .all()
      : [];

    if (requestConversationId && !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    const activeTopicId = requestedTopicId ?? conversation?.topicId ?? null;

    // Resolve system prompt from topic, or fall back to default
    let systemPrompt =
      'You are a voice assistant. Your responses will be spoken aloud, so keep them SHORT — 1 to 3 sentences max. Answer directly without preamble, lists, or elaboration. If the topic is complex, give the core answer first and offer to explain more. Respond in the same language the user speaks in.';
    let topicName = 'Conversation';

    if (activeTopicId) {
      const [topic] = db
        .select()
        .from(schema.topics)
        .where(eq(schema.topics.id, activeTopicId))
        .all();
      if (topic) {
        systemPrompt = topic.systemPrompt;
        topicName = topic.name;
      }
    }

    // Auto-create conversation if none provided
    let conversationId = requestConversationId;
    if (!conversationId) {
      conversationId = `conv-${Date.now()}`;
      db.insert(schema.conversations)
        .values({
          id: conversationId,
          topicId: activeTopicId || 'custom',
          title: buildConversationTitle({
            id: activeTopicId || 'custom',
            name: topicName,
          }),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
    }

    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    const lastUserText: string =
      typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (conversationId && lastUserText.trim()) {
      db.insert(schema.messages)
        .values({
          id: `msg-${Date.now()}-user`,
          conversationId,
          role: 'user',
          content: lastUserText,
          createdAt: new Date(),
        })
        .run();
      db.update(schema.conversations)
        .set({ updatedAt: new Date() })
        .where(eq(schema.conversations.id, conversationId))
        .run();
    }

    const client = new OpenAI({
      apiKey: process.env.ARK_API_KEY,
      baseURL: resolveArkBaseUrl(),
    });

    const encoder = new TextEncoder();

    const t0 = Date.now();
    const turnId = Math.random().toString(36).slice(2, 10);

    const readable = new ReadableStream({
      async start(controller) {
        let ttsSessionActive = false;
        let llmDone = false;
        let closed = false;

        const marks: Record<string, number> = {};
        const mark = (name: string) => {
          if (marks[name] === undefined) marks[name] = Date.now() - t0;
        };
        const updateMark = (name: string) => {
          marks[name] = Date.now() - t0;
        };
        let audioChunkCount = 0;
        let audioBytesTotal = 0;
        let textCharCount = 0;
        let logged = false;
        let ttsFailed = false;
        let ttsFailReason: string | null = null;
        let assistantText = '';
        let assistantPersisted = false;
        const logTurn = (outcome: string, extra?: Record<string, unknown>) => {
          if (logged) return;
          logged = true;
          const payload = {
            evt: 'chat-voice.turn',
            turnId,
            outcome,
            messagesLen: messages.length,
            userLen: lastUserText.length,
            userPreview: lastUserText.slice(0, 60),
            textChars: textCharCount,
            audioChunks: audioChunkCount,
            audioBytes: audioBytesTotal,
            marks,
            totalMs: Date.now() - t0,
            ...extra,
          };
          console.log(JSON.stringify(payload));

          // Human-readable breakdown: identify the dominant phase so it's
          // obvious at a glance whether the turn was bottlenecked by LLM,
          // TTS handshake, TTS synthesis, or plumbing.
          const total = Date.now() - t0;
          const llmTtft = marks.t_llm_first_token ?? 0;
          const ttsHandshake = marks.t_tts_session_started ?? 0;
          const ttsReady = Math.max(
            marks.t_tts_session_started ?? 0,
            marks.t_llm_first_token ?? 0,
          );
          const ttsTtfb =
            marks.t_first_audio !== undefined
              ? marks.t_first_audio - ttsReady
              : 0;
          const ttsStream =
            marks.t_first_audio !== undefined &&
            marks.t_last_audio !== undefined
              ? marks.t_last_audio - marks.t_first_audio
              : 0;

          type Phase = { name: string; ms: number };
          const phases: Phase[] = [
            { name: 'LLM_TTFT', ms: llmTtft },
            { name: 'TTS_HANDSHAKE', ms: ttsHandshake },
            { name: 'TTS_SYNTHESIS', ms: ttsTtfb },
            { name: 'TTS_STREAM', ms: ttsStream },
          ];
          const bottleneck = phases.reduce((a, b) => (b.ms > a.ms ? b : a));
          const pct = (ms: number) =>
            total > 0 ? `${Math.round((ms / total) * 100)}%` : '—';

          console.log(
            `[turn ${turnId}] total=${total}ms | ` +
              `LLM_TTFT=${llmTtft}ms (${pct(llmTtft)}) ` +
              `TTS_HANDSHAKE=${ttsHandshake}ms (${pct(ttsHandshake)}) ` +
              `TTS_SYNTHESIS=${ttsTtfb}ms (${pct(ttsTtfb)}) ` +
              `TTS_STREAM=${ttsStream}ms (${pct(ttsStream)}) ` +
              `| bottleneck=${bottleneck.name}`,
          );
        };

        const enqueue = (data: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } catch {
            closed = true;
          }
        };

        const persistAssistantIfNeeded = () => {
          if (
            assistantPersisted ||
            !conversationId ||
            !assistantText.trim()
          ) {
            return;
          }

          db.insert(schema.messages)
            .values({
              id: `msg-${Date.now()}-assistant`,
              conversationId,
              role: 'assistant',
              content: assistantText,
              createdAt: new Date(),
            })
            .run();

          db.update(schema.conversations)
            .set({ updatedAt: new Date() })
            .where(eq(schema.conversations.id, conversationId))
            .run();

          assistantPersisted = true;
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
          persistAssistantIfNeeded();
          closed = true;
          enqueue('[DONE]');
          try {
            controller.close();
          } catch {}
          cleanup();
          mark('t_done');
          logTurn(ttsFailed ? 'degraded' : 'ok', {
            ttsFailReason: ttsFailReason ?? undefined,
          });
        };

        try {
          enqueue(
            JSON.stringify({
              type: 'conversation',
              conversationId,
              topicId: activeTopicId,
            }),
          );

          // 1. Start TTS setup and LLM stream in parallel to reduce time-to-first-token
          const ttsSetup = tts
            .connect()
            .then(() => {
              mark('t_tts_connected');
              return tts.startSession({
                onAudio: (chunk) => {
                  mark('t_first_audio');
                  updateMark('t_last_audio');
                  audioChunkCount += 1;
                  audioBytesTotal += chunk.length;
                  enqueue(
                    JSON.stringify({
                      type: 'audio',
                      data: chunk.toString('base64'),
                    }),
                  );
                },
                onFinished: () => {
                  mark('t_session_finished');
                  ttsSessionActive = false;
                  finish();
                },
                onError: (err) => {
                  console.error('TTS session error:', err);
                  ttsSessionActive = false;
                  flagTtsFailure(err);
                  if (llmDone) finish();
                },
              });
            })
            .then(() => {
              mark('t_tts_session_started');
            });

          // Track TTS readiness via flag (set by resolved promise callback)
          let ttsReady = false;
          const flagTtsFailure = (err: unknown) => {
            if (ttsFailed) return;
            ttsFailed = true;
            ttsFailReason =
              err instanceof TtsStallError
                ? 'tts_stall'
                : err instanceof Error
                  ? err.message
                  : 'tts_error';
            enqueue(
              JSON.stringify({ type: 'error', reason: ttsFailReason }),
            );
          };
          ttsSetup
            .then(() => {
              ttsSessionActive = true;
              ttsReady = true;
            })
            .catch(flagTtsFailure);

          const stream = await client.chat.completions.create({
            model: process.env.ARK_MODEL_ID!,
            messages: [
              {
                role: 'system',
                content: systemPrompt,
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
              mark('t_llm_first_token');
              assistantText += text;
              textCharCount += text.length;
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
          mark('t_llm_done');

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
          persistAssistantIfNeeded();
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
          mark('t_done');
          logTurn('error', {
            error: error instanceof Error ? error.message : String(error),
          });
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
