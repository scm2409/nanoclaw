/**
 * Host-side speech-to-text for voice-note attachments, via OpenRouter.
 *
 * Uses the chat-completions endpoint with an audio-capable model
 * (`input_audio` content part), NOT the dedicated /audio/transcriptions
 * endpoint: that endpoint 404s ("No endpoints available matching your
 * guardrail restrictions and data policy") when the OpenRouter account's
 * privacy settings exclude the providers hosting whisper — which is exactly
 * how this install's account is configured. google/gemini-2.5-flash passes
 * the policy and transcribes well. To use whisper instead, loosen the data
 * policy at https://openrouter.ai/settings/privacy and set
 * OPENROUTER_TRANSCRIPTION_MODEL=openai/whisper-large-v3-turbo — the code
 * below would then need the /audio/transcriptions multipart form again, so
 * in practice: pick another audio-capable *chat* model via that env var.
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
import path from 'path';

import { log } from './log.js';
import { readEnvFile } from './env.js';

const CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

/** Map a filename extension to OpenRouter's `input_audio.format` values. */
function audioFormatForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  switch (ext) {
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'ogg';
    case 'wav':
      return 'wav';
    case 'mp3':
      return 'mp3';
    case 'm4a':
      return 'm4a';
    case 'aac':
      return 'aac';
    case 'flac':
      return 'flac';
    case 'aiff':
    case 'aif':
      return 'aiff';
    default:
      // Matrix voice notes are OGG/Opus; when in doubt, that's the best bet.
      return 'ogg';
  }
}

/**
 * Transcribe an audio file on disk. Returns the transcript text, or `null`
 * if the key is unset, the request fails, or the response is malformed.
 */
export async function transcribeAudioFile(filePath: string, language?: string): Promise<string | null> {
  const env = readEnvFile(['OPENROUTER_API_KEY', 'OPENROUTER_TRANSCRIPTION_MODEL']);
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    log.debug('Skipping voice transcription: OPENROUTER_API_KEY not set');
    return null;
  }
  const model = env.OPENROUTER_TRANSCRIPTION_MODEL || DEFAULT_MODEL;

  let fileBuffer: Buffer;
  try {
    fileBuffer = fs.readFileSync(filePath);
  } catch (err) {
    log.warn('Failed to read audio file for transcription', { filePath, err });
    return null;
  }

  const languageHint = language ? ` The audio is in ${language}.` : '';
  try {
    const res = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Transcribe this audio verbatim, in its original language. ' +
                  'Reply with ONLY the transcript text — no preamble, no quotes, no commentary.' +
                  languageHint,
              },
              {
                type: 'input_audio',
                input_audio: {
                  data: fileBuffer.toString('base64'),
                  format: audioFormatForFile(filePath),
                },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      log.warn('OpenRouter transcription request failed', {
        status: res.status,
        model,
        filePath,
        body: bodyText.slice(0, 300),
      });
      return null;
    }

    const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      log.warn('OpenRouter transcription returned no text', { model, filePath });
      return null;
    }
    return text.trim();
  } catch (err) {
    log.warn('OpenRouter transcription request errored', { model, filePath, err });
    return null;
  }
}
