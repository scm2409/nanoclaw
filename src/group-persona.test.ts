import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  LOCAL_FACTS_FILE,
  PERSONA_PREPEND_FILE,
  readGroupLocalFacts,
  readGroupPersona,
  stageGroupPersona,
} from './group-persona.js';
import { log } from './log.js';

const TMP = '/tmp/nanoclaw-group-persona-test';

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('readGroupPersona', () => {
  it('returns null when the prepend file is absent', () => {
    expect(readGroupPersona(TMP)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns null for an empty / whitespace-only file', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '  \n\n');
    expect(readGroupPersona(TMP)).toBeNull();
  });

  it('returns the trimmed content when present', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '\nYou are an SDR agent.\n\n');
    expect(readGroupPersona(TMP)).toBe('You are an SDR agent.');
  });

  it('does not follow a symlink', () => {
    const target = path.join(TMP, 'outside.md');
    fs.writeFileSync(target, 'host-only content\n');
    fs.symlinkSync(target, path.join(TMP, PERSONA_PREPEND_FILE));

    expect(readGroupPersona(TMP)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'Could not read group standing instructions; omitting persona',
      expect.objectContaining({ file: path.join(TMP, PERSONA_PREPEND_FILE) }),
    );
  });
});

describe('readGroupLocalFacts', () => {
  it('returns null when the local facts file is absent', () => {
    expect(readGroupLocalFacts(TMP)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns null for an empty / whitespace-only file', () => {
    fs.writeFileSync(path.join(TMP, LOCAL_FACTS_FILE), '\n  \n');
    expect(readGroupLocalFacts(TMP)).toBeNull();
  });

  it('returns the trimmed content when present', () => {
    fs.writeFileSync(path.join(TMP, LOCAL_FACTS_FILE), '\n## Boards\n\n- one\n\n');
    expect(readGroupLocalFacts(TMP)).toBe('## Boards\n\n- one');
  });

  it('does not follow a symlink', () => {
    const target = path.join(TMP, 'outside.md');
    fs.writeFileSync(target, 'host-only content\n');
    fs.symlinkSync(target, path.join(TMP, LOCAL_FACTS_FILE));

    expect(readGroupLocalFacts(TMP)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'Could not read group local facts; omitting them',
      expect.objectContaining({ file: path.join(TMP, LOCAL_FACTS_FILE) }),
    );
  });

  it('is a separate document from the persona prepend', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), 'persona body\n');
    fs.writeFileSync(path.join(TMP, LOCAL_FACTS_FILE), 'local body\n');

    expect(readGroupPersona(TMP)).toBe('persona body');
    expect(readGroupLocalFacts(TMP)).toBe('local body');
  });
});

describe('stageGroupPersona', () => {
  it('creates standing instructions once', () => {
    expect(stageGroupPersona(TMP, 'You are concise.\n\n')).toBe(true);
    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(path.join(TMP, PERSONA_PREPEND_FILE), 'utf-8')).toBe('You are concise.\n');
  });

  it('does not replace an existing symlink', () => {
    const target = path.join(TMP, 'target.md');
    fs.writeFileSync(target, 'keep me\n');
    fs.symlinkSync(target, path.join(TMP, PERSONA_PREPEND_FILE));

    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me\n');
  });
});
