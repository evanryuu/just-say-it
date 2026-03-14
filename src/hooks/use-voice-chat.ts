'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type ChatState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const INTERRUPT_VOLUME_THRESHOLD = 0.12;
const BARGE_IN_GRACE_MS = 700;
const BARGE_IN_REQUIRED_FRAMES = 10;

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
  const isSpeakingRef = useRef(false);
  const speakingStartedAtRef = useRef(0);
  const loudFramesRef = useRef(0);

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

      // Barge-in: interrupt AI speaking if user speaks
      if (
        isSpeakingRef.current &&
        Date.now() - speakingStartedAtRef.current > BARGE_IN_GRACE_MS
      ) {
        if (normalized > INTERRUPT_VOLUME_THRESHOLD) {
          loudFramesRef.current += 1;
        } else {
          loudFramesRef.current = 0;
        }

        if (loudFramesRef.current >= BARGE_IN_REQUIRED_FRAMES) {
          window.speechSynthesis.cancel();
          isSpeakingRef.current = false;
          loudFramesRef.current = 0;
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

  const speakText = useCallback((text: string): Promise<void> => {
    return new Promise((resolve) => {
      if (!text.trim()) {
        resolve();
        return;
      }

      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.1;
      utter.volume = 1;
      utter.lang = navigator.language || 'zh-CN';

      // Pick a voice matching the user's language
      const voices = window.speechSynthesis.getVoices();
      const lang = navigator.language || 'zh-CN';
      const match = voices.find((v) => v.lang.startsWith(lang.slice(0, 2)));
      if (match) utter.voice = match;

      isSpeakingRef.current = true;
      loudFramesRef.current = 0;
      speakingStartedAtRef.current = 0;
      let hasStarted = false;
      const startTimer = window.setTimeout(() => {
        if (!hasStarted) {
          setErrorMessage(
            'Audio playback did not start. Check system output volume and browser autoplay/sound settings.'
          );
        }
      }, 2000);
      const safetyTimer = window.setTimeout(() => {
        // Some browsers occasionally fail to emit onend/onerror.
        window.clearTimeout(startTimer);
        isSpeakingRef.current = false;
        loudFramesRef.current = 0;
        resolve();
      }, 15000);
      utter.onstart = () => {
        hasStarted = true;
        speakingStartedAtRef.current = Date.now();
        window.clearTimeout(startTimer);
      };
      utter.onend = () => {
        window.clearTimeout(startTimer);
        window.clearTimeout(safetyTimer);
        isSpeakingRef.current = false;
        loudFramesRef.current = 0;
        resolve();
      };
      utter.onerror = () => {
        window.clearTimeout(startTimer);
        window.clearTimeout(safetyTimer);
        isSpeakingRef.current = false;
        loudFramesRef.current = 0;
        setErrorMessage(
          'Audio playback failed. Try changing the browser/system voice and retry.'
        );
        resolve();
      };
      window.speechSynthesis.speak(utter);
    });
  }, []);

  // Forward declaration ref so processTranscript can call startListeningInternal
  const startListeningInternalRef = useRef<() => void>(() => {});

  const processTranscript = useCallback(
    async (text: string) => {
      stopRecognition();
      setInterimText('');
      setErrorMessage('');
      setState('thinking');

      const userMsg: Message = { role: 'user', content: text };
      const updated = [...messagesRef.current, userMsg];
      setMessages(updated);
      messagesRef.current = updated;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: updated }),
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

        setState('speaking');

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let fullText = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) {
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') continue;
              try {
                const { text: t } = JSON.parse(payload);
                fullText += t;
              } catch {}
            }
          }
        }

        const assistantMsg: Message = {
          role: 'assistant',
          content: fullText,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        messagesRef.current = [...messagesRef.current, assistantMsg];

        if (!fullText.trim()) {
          setErrorMessage('Assistant returned an empty response. Please try again.');
        }
        await speakText(fullText);

        if (!isStoppingRef.current) {
          startListeningInternalRef.current();
        }
      } catch (e) {
        console.error('Chat error:', e);
        const message =
          e instanceof Error ? e.message : 'Unknown error while calling /api/chat';
        setErrorMessage(message);
        if (!isStoppingRef.current) {
          startListeningInternalRef.current();
        }
      }
    },
    [stopRecognition, speakText]
  );

  const startListeningInternal = useCallback(() => {
    if (isStoppingRef.current) return;

    const SpeechRec =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRec) {
      console.error('SpeechRecognition not supported in this browser.');
      setState('idle');
      return;
    }

    const rec = new SpeechRec();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || 'zh-CN';

    rec.onstart = () => {
      if (!isStoppingRef.current) setState('listening');
    };

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      setInterimText(final || interim);
      if (final) processTranscript(final);
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech' && !isStoppingRef.current) {
        startListeningInternalRef.current();
      }
    };

    rec.onend = () => {
      if (stateRef.current === 'listening' && !isStoppingRef.current) {
        startListeningInternalRef.current();
      }
    };

    rec.start();
    recognitionRef.current = rec;
  }, [processTranscript]);

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
    window.speechSynthesis.cancel();
    isSpeakingRef.current = false;
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
      window.speechSynthesis?.cancel();
      cancelAnimationFrame(rafRef.current);
      audioContextRef.current?.close();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [stopRecognition]);

  return { state, volume, messages, interimText, errorMessage, startChat, stopChat };
}
