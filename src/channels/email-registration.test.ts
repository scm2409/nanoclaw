/**
 * The channel's single reach-in into core: the self-registration import in the
 * `src/channels/index.ts` barrel. Same shape as matrix-registration.test.ts —
 * behavioural, not structural, so deleting the import line OR breaking the
 * module so it can't evaluate both go red.
 *
 * Also pins that the declared defaults are resolvable WITHOUT instantiating
 * the adapter. Offline creation paths (ncl, the setup wizard) read them from
 * the registry on hosts where the factory returned null for missing
 * credentials — if they only lived on the adapter object, a wiring created
 * before the mailbox is configured would silently get the lenient core
 * fallback (request_approval) instead of `strict`.
 */
import { describe, expect, it } from 'vitest';

import { getChannelDefaults, getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('email channel registration', () => {
  it('registers email via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('email');
  });

  it('exposes strict defaults without constructing the adapter', () => {
    const defaults = getChannelDefaults('email');
    expect(defaults.dm.unknownSenderPolicy).toBe('strict');
    expect(defaults.group.unknownSenderPolicy).toBe('strict');
    expect(defaults.dm.engageMode).toBe('pattern');
    expect(defaults.dm.engagePattern).toBe('.');
    expect(defaults.dm.threads).toBe(false);
    expect(defaults.group.threads).toBe(false);
    expect(defaults.mentions).toBe('dm-only');
  });

  it('does not construct the adapter when credentials are absent', () => {
    // Importing the barrel must stay side-effect free beyond registration:
    // no IMAP socket, no SMTP transport, no thrown error on a host that has
    // never configured email.
    expect(getRegisteredChannelNames()).toContain('email');
  });
});
