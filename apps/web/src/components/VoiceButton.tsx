'use client';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';

type SR = { start(): void; stop(): void; onresult: (e: any) => void; onerror: (e: any) => void; onend: () => void; interimResults: boolean; continuous: boolean; lang: string };

/**
 * Dictation: browser speech recognition first. Falls back to recording audio and sending it
 * to the server transcription endpoint (if configured) behind the Transcriber interface.
 */
export function VoiceButton({ onText, lang = 'en-US' }: { onText: (t: string) => void; lang?: string }) {
  const [state, setState] = useState<'idle' | 'listening' | 'recording' | 'transcribing'>('idle');
  const [error, setError] = useState('');
  const rec = useRef<SR | null>(null);
  const media = useRef<MediaRecorder | null>(null);

  async function start() {
    setError('');
    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (Ctor) {
      const r: SR = new Ctor();
      r.lang = lang; r.interimResults = false; r.continuous = true;
      let text = '';
      r.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript + ' '; };
      r.onerror = (e) => setError(`Speech recognition: ${e.error}`);
      r.onend = () => { setState('idle'); if (text.trim()) onText(text.trim()); };
      rec.current = r; r.start(); setState('listening');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState('transcribing');
        try {
          const r = await api<{ text: string }>(`/inbox/voice/transcribe?lang=${lang.slice(0, 2)}`, { method: 'POST', raw: new Blob(chunks, { type: mr.mimeType || 'audio/webm' }) });
          if (r.text) onText(r.text);
        } catch (err) { setError((err as Error).message); } finally { setState('idle'); }
      };
      media.current = mr; mr.start(); setState('recording');
    } catch { setError('Microphone unavailable'); }
  }

  function stop() { rec.current?.stop(); media.current?.stop(); }

  return (
    <span className="row">
      {state === 'idle' && <button type="button" className="btn" onClick={start} title="Dictate an instruction">🎙 Dictate</button>}
      {(state === 'listening' || state === 'recording') && <button type="button" className="btn danger" onClick={stop}>■ Stop</button>}
      {state === 'transcribing' && <span className="muted small">Transcribing…</span>}
      {error && <span className="error">{error}</span>}
    </span>
  );
}
