/**
 * Matrix encrypted-attachment crypto (the `content.file` format, spec §
 * "Sending encrypted attachments" — AES-256-CTR + SHA-256 ciphertext hash).
 *
 * In an E2EE room, media events carry no plaintext `content.url`; instead
 * `content.file` holds the mxc URL of the *ciphertext* plus the JWK key, IV,
 * and a SHA-256 hash of the ciphertext. @beeper/chat-adapter-matrix@0.2.0's
 * extractAttachments() only reads `content.url`, so every encrypted
 * attachment (including all voice notes in encrypted DMs) silently parsed to
 * an empty attachments list. matrix.ts overrides extractAttachments and uses
 * decryptMatrixAttachment() below to close that gap.
 *
 * encryptMatrixAttachment() is the inverse, used by the live-test harness to
 * send a faithful encrypted voice note the way a real client (Element) does.
 *
 * Base64 conventions per spec: JWK `k` is unpadded base64url; `iv` and
 * `hashes.sha256` are unpadded standard base64. Node's Buffer accepts both
 * padded and unpadded input for each variant.
 */
import crypto from 'crypto';

export interface EncryptedFile {
  url: string;
  key: { kty: string; alg: string; k: string; ext?: boolean; key_ops?: string[] };
  iv: string;
  hashes: { sha256: string };
  v: string;
}

export function isEncryptedFile(v: unknown): v is EncryptedFile {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  const key = f.key as Record<string, unknown> | undefined;
  const hashes = f.hashes as Record<string, unknown> | undefined;
  return (
    typeof f.url === 'string' &&
    typeof f.iv === 'string' &&
    typeof key?.k === 'string' &&
    typeof hashes?.sha256 === 'string'
  );
}

/** Unpadded-base64 (standard alphabet), as the Matrix spec uses for iv/hashes. */
function b64unpadded(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}

/**
 * Decrypt a downloaded ciphertext using the event's `file` metadata.
 * Throws on hash mismatch or malformed key material — callers treat any
 * throw as "attachment unavailable", the same as a failed download.
 */
export function decryptMatrixAttachment(ciphertext: Buffer, file: EncryptedFile): Buffer {
  const expectedHash = file.hashes.sha256.replace(/=+$/, '');
  const actualHash = b64unpadded(crypto.createHash('sha256').update(ciphertext).digest());
  if (actualHash !== expectedHash) {
    throw new Error('Matrix attachment ciphertext hash mismatch');
  }

  const key = Buffer.from(file.key.k, 'base64url');
  if (key.length !== 32) {
    throw new Error(`Matrix attachment key must be 32 bytes, got ${key.length}`);
  }
  const iv = Buffer.from(file.iv, 'base64');
  if (iv.length !== 16) {
    throw new Error(`Matrix attachment IV must be 16 bytes, got ${iv.length}`);
  }

  const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a plaintext the way Matrix clients do before upload. Returns the
 * ciphertext (upload it, put the resulting mxc URL into `file.url`) and the
 * `file` metadata minus `url`. IV is 8 random bytes + 8 zero bytes, per the
 * spec's guard against CTR counter overflow on large files.
 */
export function encryptMatrixAttachment(plaintext: Buffer): {
  ciphertext: Buffer;
  file: Omit<EncryptedFile, 'url'>;
} {
  const key = crypto.randomBytes(32);
  const iv = Buffer.concat([crypto.randomBytes(8), Buffer.alloc(8)]);

  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    ciphertext,
    file: {
      v: 'v2',
      key: {
        kty: 'oct',
        alg: 'A256CTR',
        ext: true,
        key_ops: ['encrypt', 'decrypt'],
        k: key.toString('base64url').replace(/=+$/, ''),
      },
      iv: b64unpadded(iv),
      hashes: { sha256: b64unpadded(crypto.createHash('sha256').update(ciphertext).digest()) },
    },
  };
}
