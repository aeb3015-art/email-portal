import { config } from '../config.js';
import { HttpError } from '../errors.js';

/** Server-side transcription fallback for browsers without the Web Speech API. */
export interface Transcriber {
  transcribe(audio: Buffer, mimeType: string, language?: string): Promise<string>;
}

/** OpenAI-compatible /audio/transcriptions endpoint (OpenAI Whisper, Groq, a self-hosted whisper server...). */
export class WhisperCompatibleTranscriber implements Transcriber {
  constructor(private url: string, private apiKey?: string) {}
  async transcribe(audio: Buffer, mimeType: string, language?: string): Promise<string> {
    const form = new FormData();
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : mimeType.includes('wav') ? 'wav' : 'webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    if (language) form.append('language', language);
    const res = await fetch(this.url, { method: 'POST', headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}, body: form });
    if (!res.ok) throw new HttpError(502, `Transcription service returned ${res.status}`, 'transcription_failed');
    const json = (await res.json()) as { text?: string };
    return (json.text ?? '').trim();
  }
}

export function getTranscriber(): Transcriber | null {
  return config.TRANSCRIPTION_API_URL ? new WhisperCompatibleTranscriber(config.TRANSCRIPTION_API_URL, config.TRANSCRIPTION_API_KEY) : null;
}
