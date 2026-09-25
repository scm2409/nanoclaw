/**
 * Cross-sign the bot's own Matrix device at startup.
 *
 * Element X marks every message from a device its owner has not signed with
 * "Encrypted by a device not verified by its owner". The bot account already
 * has a cross-signing identity whose private keys live in secret storage,
 * unlocked by MATRIX_RECOVERY_KEY — but @beeper/chat-adapter-matrix uses that
 * key only to load the room-key backup and never signs its own device
 * (observed 2026-09-25: no bot device carried a self-signing signature).
 *
 * Two ways to sign, depending on where the private keys are:
 *   - cached locally (the restored crypto store has them) → crossSignDevice();
 *     bootstrapCrossSigning() would do nothing in this state;
 *   - only in secret storage → bootstrapCrossSigning({}) imports them (the
 *     adapter's getSecretStorageKey callback supplies the recovery key) and
 *     signs this device.
 *
 * Hard guard: if the keys are in neither place, do nothing. Called then,
 * bootstrapCrossSigning() would create a brand-new cross-signing identity for
 * the account, silently invalidating every verification the operator made.
 *
 * Best-effort, never throws — the channel works exactly as before if this fails.
 */
import { log } from '../log.js';

export type CrossSigningOutcome = 'already-verified' | 'signed' | 'no-keys' | 'no-crypto' | 'failed';

export async function ensureOwnDeviceCrossSigned(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  opts: { confirmTries?: number; confirmDelayMs?: number } = {},
): Promise<CrossSigningOutcome> {
  const crypto = client?.getCrypto?.();
  const userId: string | undefined = client?.getUserId?.();
  const deviceId: string | undefined = client?.getDeviceId?.();
  if (!crypto || !userId || !deviceId) return 'no-crypto';

  try {
    const isVerified = async () =>
      Boolean((await crypto.getDeviceVerificationStatus(userId, deviceId))?.crossSigningVerified);

    // Make sure our own public cross-signing keys are known locally — importing
    // private keys fails silently without them.
    await crypto.userHasCrossSigningKeys(userId, true);
    if (await isVerified()) {
      log.info('Matrix device already cross-signed', { deviceId });
      return 'already-verified';
    }

    const status = await crypto.getCrossSigningStatus();
    if (status?.privateKeysCachedLocally?.selfSigningKey) {
      await crypto.crossSignDevice(deviceId);
    } else if (status?.privateKeysInSecretStorage) {
      await crypto.bootstrapCrossSigning({});
    } else {
      log.warn('Matrix device not cross-signed and no cross-signing keys available (check MATRIX_RECOVERY_KEY)', {
        deviceId,
      });
      return 'no-keys';
    }

    // The signature is uploaded at once, but the local verification status
    // only follows after our own keys are re-queried — seen live, the check
    // right after signing still read "unverified". Give it a moment.
    const tries = opts.confirmTries ?? 10;
    for (let i = 0; i < tries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, opts.confirmDelayMs ?? 3_000));
      if (await isVerified()) {
        log.info('Matrix device cross-signed', { deviceId });
        return 'signed';
      }
    }
    log.warn('Matrix device cross-signing did not take effect', { deviceId });
    return 'failed';
  } catch (err) {
    log.warn('Matrix device cross-signing failed', { deviceId, err });
    return 'failed';
  }
}

/**
 * Stop @beeper/chat-adapter-matrix from writing the account's private
 * cross-signing keys to the Chat SDK state in plaintext.
 *
 * Once this device holds those keys (see ensureOwnDeviceCrossSigned), the
 * adapter exports them as a "secrets bundle" into data/v2.db on a timer and at
 * shutdown, and re-imports them at startup. The keys already live in the
 * crypto snapshot — encrypted with MATRIX_RECOVERY_KEY — and in the account's
 * server-side secret storage, from which ensureOwnDeviceCrossSigned re-imports
 * them if needed. The plaintext copy only widens exposure (anything that
 * copies v2.db, such as a backup), so the persist hook is replaced by one that
 * removes any copy written earlier. Patches the adapter's private
 * `maybePersistSecretsBundle` (@beeper/chat-adapter-matrix@0.2.0); a no-op if
 * that hook is gone. Mutates and returns the adapter.
 */
export function wrapWithoutPlaintextSecretsBundle<T extends object>(adapter: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = adapter as any;
  if (typeof a.maybePersistSecretsBundle !== 'function') return adapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a.maybePersistSecretsBundle = async function (this: any): Promise<void> {
    try {
      const key = this.getSecretsBundleStorageKey?.();
      if (key && this.stateAdapter) await this.stateAdapter.delete(key);
    } catch (err) {
      log.debug('Matrix: could not remove persisted secrets bundle', { err });
    }
  };
  return adapter;
}
