/**
 * `extractAndTranscribeAttachments` (router.ts's inbound-channel path): stages
 * attachments to disk exactly like writeSessionMessage's internal
 * extractAttachmentFiles, then transcribes any attachment a channel adapter
 * flagged `isVoice` (chat-sdk-bridge.ts's `isVoiceAttachment` hook).
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-transcription' };
});

const { transcribeAudioFile } = vi.hoisted(() => ({ transcribeAudioFile: vi.fn() }));
vi.mock('./attachment-transcription.js', () => ({ transcribeAudioFile }));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { initSessionFolder, extractAndTranscribeAttachments } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-transcription';
const AG = 'ag-transcribe';
const SESS = 'sess-transcribe';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: AG, name: 'Transcribe', folder: 'transcribe', agent_provider: null, created_at: now() });
  const sess: Session = {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  createSession(sess);
  initSessionFolder(AG, SESS);

  transcribeAudioFile.mockReset();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

const audioBase64 = Buffer.from('fake-ogg-bytes').toString('base64');

describe('extractAndTranscribeAttachments', () => {
  it('transcribes an attachment flagged isVoice and stashes the result on the attachment', async () => {
    transcribeAudioFile.mockResolvedValue('hello from the voice note');

    const content = JSON.stringify({
      text: '',
      attachments: [{ name: 'note.ogg', mimeType: 'audio/ogg', isVoice: true, data: audioBase64 }],
    });

    const result = await extractAndTranscribeAttachments(AG, SESS, 'msg-voice-1', content);
    const parsed = JSON.parse(result);

    expect(parsed.attachments[0].transcript).toBe('hello from the voice note');
    expect(parsed.attachments[0].localPath).toBe('inbox/msg-voice-1/note.ogg');
    expect(parsed.attachments[0].data).toBeUndefined();
    expect(transcribeAudioFile).toHaveBeenCalledTimes(1);
  });

  it('does not call transcribeAudioFile for an attachment not flagged isVoice', async () => {
    const content = JSON.stringify({
      text: '',
      attachments: [{ name: 'clip.ogg', mimeType: 'audio/ogg', data: audioBase64 }],
    });

    const result = await extractAndTranscribeAttachments(AG, SESS, 'msg-plain-1', content);
    const parsed = JSON.parse(result);

    expect(parsed.attachments[0].transcript).toBeUndefined();
    expect(parsed.attachments[0].localPath).toBe('inbox/msg-plain-1/clip.ogg');
    expect(transcribeAudioFile).not.toHaveBeenCalled();
  });

  it('degrades to the plain attachment (no transcript) when transcription fails', async () => {
    transcribeAudioFile.mockResolvedValue(null);

    const content = JSON.stringify({
      text: '',
      attachments: [{ name: 'note.ogg', mimeType: 'audio/ogg', isVoice: true, data: audioBase64 }],
    });

    const result = await extractAndTranscribeAttachments(AG, SESS, 'msg-voice-2', content);
    const parsed = JSON.parse(result);

    expect(parsed.attachments[0].transcript).toBeUndefined();
    expect(parsed.attachments[0].localPath).toBe('inbox/msg-voice-2/note.ogg');
  });

  it('passes through text-only messages with no attachments unchanged', async () => {
    const content = JSON.stringify({ text: 'just a plain message' });

    const result = await extractAndTranscribeAttachments(AG, SESS, 'msg-text-1', content);

    expect(result).toBe(content);
    expect(transcribeAudioFile).not.toHaveBeenCalled();
  });
});
