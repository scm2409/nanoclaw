/**
 * Host-side speech-to-text for voice-note attachments, via OpenRouter's
 * transcription endpoint (model: openai/whisper-large-v3-turbo).
 *
 * Runs on the host, not in the container — the OneCLI credential proxy only
 * covers container egress, so this reads its own key from .env via
 * readEnvFile (never loaded into process.env, per that helper's contract).
 *
 * Never throws. A missing key, network failure, or non-200 response all
 * degrade to `null` so a voice note that fails to transcribe still delivers
 * as a plain attachment hint instead of dropping the message.
 */
import fs from 'fs';

import { log } from './log.js';
import { readEnvFile } from './env.js';

const TRANSCRIPTION_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const MODEL = 'openai/whisper-large-v3-turbo';

/**
 * Transcribe an audio file on disk. Returns the transcript text, or `null`
 * if the key is unset, the request fails, or the response is malformed.
 */
export async function transcribeAudioFile(filePath: string, language?: string): Promise<string | null> {
  const { OPENROUTER_API_KEY: apiKey } = readEnvFile(['OPENROUTER_API_KEY']);
  if (!apiKey) {
    log.debug('Skipping voice transcription: OPENROUTER_API_KEY not set');
    return null;
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = fs.readFileSync(filePath);
  } catch (err) {
    log.warn('Failed to read audio file for transcription', { filePath, err });
    return null;
  }

  try {
    const form = new FormData();
    form.append('model', MODEL);
    if (language) form.append('language', language);
    form.append('file', new Blob([fileBuffer]), filePath.split('/').pop() ?? 'audio');

    const res = await fetch(TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      log.warn('OpenRouter transcription request failed', { status: res.status, filePath });
      return null;
    }

    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      log.warn('OpenRouter transcription returned no text', { filePath });
      return null;
    }
    return body.text;
  } catch (err) {
    log.warn('OpenRouter transcription request errored', { filePath, err });
    return null;
  }
}
