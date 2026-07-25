import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

import { encryptMatrixAttachment, decryptMatrixAttachment, isEncryptedFile } from './matrix-media-crypto.js';

describe('matrix-media-crypto', () => {
  it('round-trips binary data byte-for-byte', () => {
    const plaintext = crypto.randomBytes(10_000);
    const { ciphertext, file } = encryptMatrixAttachment(plaintext);

    expect(ciphertext.equals(plaintext)).toBe(false);
    const decrypted = decryptMatrixAttachment(ciphertext, { ...file, url: 'mxc://example.org/abc' });
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('rejects tampered ciphertext (hash mismatch)', () => {
    const { ciphertext, file } = encryptMatrixAttachment(Buffer.from('voice note audio bytes'));
    ciphertext[0] ^= 0xff;
    expect(() => decryptMatrixAttachment(ciphertext, { ...file, url: 'mxc://x/y' })).toThrow(/hash mismatch/);
  });

  it('accepts padded base64 variants for iv and hash', () => {
    const plaintext = Buffer.from('padding tolerance');
    const { ciphertext, file } = encryptMatrixAttachment(plaintext);
    // Re-pad the unpadded fields — some clients send padded base64.
    const pad = (s: string): string => s + '='.repeat((4 - (s.length % 4)) % 4);
    const padded = {
      ...file,
      url: 'mxc://x/y',
      iv: pad(file.iv),
      hashes: { sha256: pad(file.hashes.sha256) },
    };
    expect(decryptMatrixAttachment(ciphertext, padded).equals(plaintext)).toBe(true);
  });

  it('isEncryptedFile discriminates correctly', () => {
    const { file } = encryptMatrixAttachment(Buffer.from('x'));
    expect(isEncryptedFile({ ...file, url: 'mxc://x/y' })).toBe(true);
    expect(isEncryptedFile(undefined)).toBe(false);
    expect(isEncryptedFile({})).toBe(false);
    expect(isEncryptedFile({ url: 'mxc://x/y' })).toBe(false);
    expect(isEncryptedFile({ ...file, url: 'mxc://x/y', key: {} })).toBe(false);
  });
});
