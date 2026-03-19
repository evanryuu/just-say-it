'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioStreamPlayer } from '@/lib/audio-stream-player';

export type ChatState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const INTERRUPT_VOLUME_THRESHOLD = 0.25;
const BARGE_IN_GRACE_MS = 1500;
const BARGE_IN_REQUIRED_FRAMES = 20;

function getMicErrorMessage(error: unknown): string {
  const fallback = 'Unable to access microphone.';
  if (!(error instanceof DOMException)) return fallback;

  if (error.name === 'NotAllowedError') {
    return 'Microphone access is blocked. Please allow mic access in browser site settings, then retry.';
  }
  if (error.name === 'NotFoundError') {
    return 'No microphone device was found. Please connect a mic and try again.';
  }
  if (error.name === 'NotReadableError') {
    return 'Microphone is busy or unavailable. Close other apps using the mic and retry.';
  }
  if (error.name === 'SecurityError') {
    return 'Microphone access requires a secure context (https or localhost).';
  }

  return `${fallback} ${error.name}`;
}

function normalizeApiErrorMessage(raw: string, status: number): string {
  const trimmed = raw.trim();
  if (!trimmed) return `API error (status ${status})`;
  if (trimmed.includes('<!DOCTYPE') || trimmed.startsWith('<html')) {
    return 'Server returned an HTML 404/500 page. Check ARK_BASE_URL and model endpoint settings.';
  }
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
}

export function useVoiceChat() {
  const [state, setState] = useState<ChatState>('idle');
  const [volume, setVolume] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [interimText, setInterimText] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const stateRef = useRef<ChatState>('idle');
  const messagesRef = useRef<Message[]>([]);
  const isStoppingRef = useRef(false);
  const audioPlayerRef = useRef<AudioStreamPlayer | null>(null);
  const speakingStartedAtRef = useRef(0);
  const loudFramesRef = useRef(0);
  const chatAbortRef = useRef<AbortController | null>(null);

  // Keep refs in sync
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const stopVolumeLoop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    setVolume(0);
  }, []);

  const startVolumeLoop = useCallback((stream: MediaStream) => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    audioContextRef.current = ctx;
    analyserRef.current = analyser;

    const buf = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteTimeDomainData(buf);

      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const normalized = Math.min(rms * 8, 1);
      setVolume(normalized);

      // Barge-in: interrupt AI speaking if user speaks loudly enough
      if (
        stateRef.current === 'speaking' &&
        audioPlayerRef.current?.isPlaying &&
        Date.now() - speakingStartedAtRef.current > BARGE_IN_GRACE_MS
      ) {
        if (normalized > INTERRUPT_VOLUME_THRESHOLD) {
          loudFramesRef.current += 1;
        } else {
          loudFramesRef.current = 0;
        }

        if (loudFramesRef.current >= BARGE_IN_REQUIRED_FRAMES) {
          // Stop audio playback
          audioPlayerRef.current?.stopAll();
          // Cancel in-flight chat request (server will CancelSession)
          chatAbortRef.current?.abort();
          chatAbortRef.current = null;
          loudFramesRef.current = 0;
          setState('listening');
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onend = null;
      recognitionRef.current.onerror = null;
      try {
        recognitionRef.current.abort();
      } catch {}
      recognitionRef.current = null;
    }
  }, []);

  // Forward declaration ref so processTranscript can call startListeningInternal
  const startListeningInternalRef = useRef<() => void>(() => {});

  const processTranscript = useCallback(
    async (text: string) => {
      // Don't stop recognition — keep it active for barge-in
      setInterimText('');
      setErrorMessage('');
      setState('thinking');

      // Cancel any previous in-flight chat request
      chatAbortRef.current?.abort();

      // Stop any ongoing audio playback
      audioPlayerRef.current?.stopAll();

      const userMsg: Message = { role: 'user', content: text };
      const updated = [...messagesRef.current, userMsg];
      setMessages(updated);
      messagesRef.current = updated;

      const abortController = new AbortController();
      chatAbortRef.current = abortController;

      try {
        const res = await fetch('/api/chat-voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: updated }),
          signal: abortController.signal,
        });

        if (!res.ok) {
          let serverMessage = '';
          try {
            const payload = await res.json();
            if (typeof payload?.error === 'string') {
              serverMessage = payload.error;
            }
          } catch {
            try {
              serverMessage = (await res.text()).trim();
            } catch {}
          }

          throw new Error(normalizeApiErrorMessage(serverMessage, res.status));
        }

        // Set up audio stream player for this response
        const audioPlayer = new AudioStreamPlayer({
          onPlaybackStart: () => {
            speakingStartedAtRef.current = Date.now();
            loudFramesRef.current = 0;
            if (!isStoppingRef.current) {
              setState('speaking');
            }
          },
          onPlaybackEnd: () => {
            loudFramesRef.current = 0;
            if (!isStoppingRef.current) {
              setState('listening');
            }
          },
          onError: (err) => {
            console.error('Audio playback error:', err);
          },
        });
        audioPlayerRef.current = audioPlayer;

        // Add a placeholder assistant message and update it incrementally
        const assistantMsg: Message = { role: 'assistant', content: '' };
        setMessages((prev) => [...prev, assistantMsg]);
        messagesRef.current = [...messagesRef.current, assistantMsg];

        let fullText = '';
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (abortController.signal.aborted) break;

          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) {
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') continue;
              try {
                const evt = JSON.parse(payload);
                if (evt.type === 'text' && evt.delta) {
                  fullText += evt.delta;
                  setMessages((prev) => {
                    const next = [...prev];
                    next[next.length - 1] = { role: 'assistant', content: fullText };
                    return next;
                  });
                } else if (evt.type === 'audio' && evt.data) {
                  audioPlayer.enqueueChunk(evt.data);
                } else if (evt.type === 'error') {
                  console.error('Server error:', evt.message);
                }
              } catch {}
            }
          }
        }

        // Signal no more audio chunks
        audioPlayer.markFinished();

        // Final sync of messagesRef
        messagesRef.current = [...messagesRef.current.slice(0, -1), { role: 'assistant', content: fullText }];

        if (!fullText.trim()) {
          setErrorMessage('Assistant returned an empty response. Please try again.');
          if (!isStoppingRef.current) {
            setState('listening');
          }
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          // Barge-in aborted the request — this is expected
          return;
        }
        console.error('Chat error:', e);
        const message =
          e instanceof Error ? e.message : 'Unknown error while calling /api/chat-voice';
        setErrorMessage(message);
        if (!isStoppingRef.current) {
          setState('listening');
        }
      }
    },
    [stopRecognition]
  );

  const startListeningInternal = useCallback(() => {
    if (isStoppingRef.current) return;

    // Don't create a new recognition if one already exists
    if (recognitionRef.current) return;

    const SpeechRec =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRec) {
      console.error('SpeechRecognition not supported in this browser.');
      setState('idle');
      return;
    }

    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'zh-CN';

    rec.onstart = () => {
      if (!isStoppingRef.current && stateRef.current !== 'thinking' && stateRef.current !== 'speaking') {
        setState('listening');
      }
    };

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = '';
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      setInterimText(finalText || interim);

      if (finalText) {
        if (stateRef.current === 'speaking') {
          // Barge-in via speech: stop audio and process new input
          audioPlayerRef.current?.stopAll();
          chatAbortRef.current?.abort();
          chatAbortRef.current = null;
          loudFramesRef.current = 0;
        }
        // Stop current recognition before processing (will restart after)
        stopRecognition();
        processTranscript(finalText);
        // Restart recognition for next input
        setTimeout(() => {
          if (!isStoppingRef.current) {
            startListeningInternalRef.current();
          }
        }, 100);
      }
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech' || e.error === 'aborted') {
        // Expected errors, just restart if appropriate
        recognitionRef.current = null;
        if (!isStoppingRef.current) {
          setTimeout(() => startListeningInternalRef.current(), 100);
        }
        return;
      }
      console.error('Speech recognition error:', e.error);
      recognitionRef.current = null;
    };

    rec.onend = () => {
      recognitionRef.current = null;
      // Restart recognition if we're in a state that needs it
      if (!isStoppingRef.current && (stateRef.current === 'listening' || stateRef.current === 'speaking')) {
        setTimeout(() => startListeningInternalRef.current(), 100);
      }
    };

    rec.start();
    recognitionRef.current = rec;
  }, [processTranscript, stopRecognition]);

  // Keep the ref updated
  useEffect(() => {
    startListeningInternalRef.current = startListeningInternal;
  }, [startListeningInternal]);

  const startChat = useCallback(async () => {
    if (stateRef.current !== 'idle') return;
    isStoppingRef.current = false;
    setErrorMessage('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('This browser does not support microphone capture.');
      setState('idle');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      mediaStreamRef.current = stream;
      startVolumeLoop(stream);
      startListeningInternal();
    } catch (error) {
      const message = getMicErrorMessage(error);
      setErrorMessage(message);
      alert(message);
      setState('idle');
    }
  }, [startVolumeLoop, startListeningInternal]);

  const stopChat = useCallback(() => {
    isStoppingRef.current = true;
    stopRecognition();
    // Stop audio playback
    audioPlayerRef.current?.stopAll();
    audioPlayerRef.current = null;
    // Cancel in-flight chat request (server will cleanup WebSocket)
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    loudFramesRef.current = 0;
    stopVolumeLoop();
    audioContextRef.current?.close();
    audioContextRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    setState('idle');
    setInterimText('');
    setErrorMessage('');
  }, [stopRecognition, stopVolumeLoop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isStoppingRef.current = true;
      stopRecognition();
      audioPlayerRef.current?.stopAll();
      chatAbortRef.current?.abort();
      cancelAnimationFrame(rafRef.current);
      audioContextRef.current?.close();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [stopRecognition]);

  return { state, volume, messages, interimText, errorMessage, startChat, stopChat };
}
