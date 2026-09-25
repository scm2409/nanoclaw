/**
 * Tests for ensureOwnDeviceCrossSigned — signs the bot's own Matrix device
 * with the account's existing cross-signing identity at startup.
 *
 * Regression context (2026-09-25): the bot device was never cross-signed, so
 * Element X marked every bot message "Encrypted by a device not verified by
 * its owner". The account's cross-signing keys sit in secret storage behind
 * MATRIX_RECOVERY_KEY; the adapter used that key only to load the key backup.
 */
import { describe, it, expect, vi } from 'vitest';

import { ensureOwnDeviceCrossSigned, wrapWithoutPlaintextSecretsBundle } from './matrix-cross-signing.js';

interface FakeOpts {
  alreadyVerified?: boolean;
  cachedSelfSigning?: boolean;
  inSecretStorage?: boolean;
  signingSticks?: boolean;
  /** Status checks after signing that still report unverified (local refresh lag). */
  lagChecks?: number;
  throwOn?: string;
}

function makeClient(opts: FakeOpts) {
  let verified = !!opts.alreadyVerified;
  let lag = opts.lagChecks ?? 0;
  const maybeThrow = (name: string) => {
    if (opts.throwOn === name) throw new Error(`${name} failed`);
  };
  const crypto = {
    userHasCrossSigningKeys: vi.fn(async () => {
      maybeThrow('userHasCrossSigningKeys');
      return true;
    }),
    getDeviceVerificationStatus: vi.fn(async () => {
      maybeThrow('getDeviceVerificationStatus');
      if (verified && lag > 0) {
        lag--;
        return { crossSigningVerified: false };
      }
      return { crossSigningVerified: verified };
    }),
    getCrossSigningStatus: vi.fn(async () => ({
      publicKeysOnDevice: true,
      privateKeysInSecretStorage: !!opts.inSecretStorage,
      privateKeysCachedLocally: {
        masterKey: !!opts.cachedSelfSigning,
        selfSigningKey: !!opts.cachedSelfSigning,
        userSigningKey: !!opts.cachedSelfSigning,
      },
    })),
    crossSignDevice: vi.fn(async () => {
      maybeThrow('crossSignDevice');
      if (opts.signingSticks !== false) verified = true;
    }),
    bootstrapCrossSigning: vi.fn(async () => {
      maybeThrow('bootstrapCrossSigning');
      if (opts.signingSticks !== false) verified = true;
    }),
  };
  const client = {
    getUserId: () => '@bot:example.org',
    getDeviceId: () => 'DEVICE',
    getCrypto: () => crypto,
  };
  return { client, crypto };
}

describe('ensureOwnDeviceCrossSigned', () => {
  it('does nothing when the device is already cross-signed', async () => {
    const { client, crypto } = makeClient({ alreadyVerified: true, inSecretStorage: true });

    expect(await ensureOwnDeviceCrossSigned(client)).toBe('already-verified');
    expect(crypto.crossSignDevice).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it('imports the keys from secret storage and signs the device', async () => {
    const { client, crypto } = makeClient({ inSecretStorage: true });

    expect(await ensureOwnDeviceCrossSigned(client)).toBe('signed');
    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith('@bot:example.org', true);
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledTimes(1);
    const bootstrapOpts = crypto.bootstrapCrossSigning.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(bootstrapOpts[0].setupNewCrossSigning).toBeFalsy();
  });

  it('signs directly with locally cached keys (bootstrap would skip signing then)', async () => {
    const { client, crypto } = makeClient({ cachedSelfSigning: true, inSecretStorage: true });

    expect(await ensureOwnDeviceCrossSigned(client)).toBe('signed');
    expect(crypto.crossSignDevice).toHaveBeenCalledWith('DEVICE');
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it('NEVER bootstraps when the keys are not in secret storage — that would mint a new identity', async () => {
    const { client, crypto } = makeClient({ inSecretStorage: false });

    expect(await ensureOwnDeviceCrossSigned(client)).toBe('no-keys');
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(crypto.crossSignDevice).not.toHaveBeenCalled();
  });

  it('waits for the local status to catch up with the uploaded signature', async () => {
    // Live on 2026-09-25: the signature reached the server, but the check right
    // after still read "unverified" and logged a false failure.
    const { client } = makeClient({ inSecretStorage: true, lagChecks: 2 });
    expect(await ensureOwnDeviceCrossSigned(client, { confirmTries: 5, confirmDelayMs: 1 })).toBe('signed');
  });

  it('reports failure when signing does not take effect', async () => {
    const { client } = makeClient({ inSecretStorage: true, signingSticks: false });
    expect(await ensureOwnDeviceCrossSigned(client, { confirmTries: 3, confirmDelayMs: 1 })).toBe('failed');
  });

  it('never throws', async () => {
    for (const throwOn of ['userHasCrossSigningKeys', 'getDeviceVerificationStatus', 'bootstrapCrossSigning']) {
      const { client } = makeClient({ inSecretStorage: true, throwOn });
      await expect(ensureOwnDeviceCrossSigned(client)).resolves.toBe('failed');
    }
    await expect(ensureOwnDeviceCrossSigned({})).resolves.toBe('no-crypto');
  });
});

describe('wrapWithoutPlaintextSecretsBundle', () => {
  // Once the device holds its cross-signing keys, @beeper/chat-adapter-matrix
  // exports them as a "secrets bundle" and writes it IN PLAINTEXT to the Chat
  // SDK state (data/v2.db). The keys already live in the crypto snapshot
  // (encrypted with the recovery key) and in server-side secret storage, so
  // that copy adds exposure (DB backups) and nothing else.
  function makeAdapter() {
    const store = new Map<string, unknown>([['scope:secrets-bundle', { cross_signing: { master_key: 'secret' } }]]);
    const exportSecretsBundle = vi.fn(async () => ({ cross_signing: { master_key: 'secret' } }));
    const adapter = {
      stateAdapter: {
        set: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
        delete: vi.fn(async (k: string) => void store.delete(k)),
      },
      getSecretsBundleStorageKey: () => 'scope:secrets-bundle',
      client: { getCrypto: () => ({ exportSecretsBundle }) },
      maybePersistSecretsBundle: vi.fn(async (_force?: boolean) => {
        throw new Error('original must not run');
      }),
    };
    return { adapter, store, exportSecretsBundle };
  }

  it('never exports or writes the bundle, and removes a copy written earlier', async () => {
    const { adapter, store, exportSecretsBundle } = makeAdapter();
    wrapWithoutPlaintextSecretsBundle(adapter);

    await adapter.maybePersistSecretsBundle(true);

    expect(exportSecretsBundle).not.toHaveBeenCalled();
    expect(adapter.stateAdapter.set).not.toHaveBeenCalled();
    expect(store.has('scope:secrets-bundle')).toBe(false);
  });

  it('never throws, and is a no-op on an adapter without the hook', async () => {
    const { adapter } = makeAdapter();
    adapter.stateAdapter.delete = vi.fn(async () => {
      throw new Error('db gone');
    });
    wrapWithoutPlaintextSecretsBundle(adapter);
    await expect(adapter.maybePersistSecretsBundle()).resolves.toBeUndefined();
    expect(() => wrapWithoutPlaintextSecretsBundle({})).not.toThrow();
  });
});
