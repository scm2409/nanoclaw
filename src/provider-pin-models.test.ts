/**
 * Which models does a group actually run?
 *
 * The pin is a union over all of them, and a model left out of that union is a
 * 404 for whichever subagent uses it — so the collection has to see the
 * subagent frontmatter, not just the group's configured model.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { subagentModels } from './provider-pin-models.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-models-'));
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const agent = (name: string, body: string) => fs.writeFileSync(path.join(dir, '.claude', 'agents', name), body);

describe('subagentModels', () => {
  it('reads the model out of each subagent frontmatter', () => {
    agent('a.md', '---\ndescription: x\nmodel: z-ai/glm-5.3-flash\neffort: low\n---\nbody\n');
    agent('b.md', '---\ndescription: y\nmodel: openai/gpt-5.6-sol\n---\nbody\n');
    expect(subagentModels(dir)).toEqual(['openai/gpt-5.6-sol', 'z-ai/glm-5.3-flash']);
  });

  it('de-duplicates and ignores subagents that inherit the group model', () => {
    agent('a.md', '---\nmodel: z-ai/glm-5.3-flash\n---\n');
    agent('b.md', '---\nmodel: z-ai/glm-5.3-flash\n---\n');
    agent('c.md', '---\ndescription: inherits\n---\n');
    expect(subagentModels(dir)).toEqual(['z-ai/glm-5.3-flash']);
  });

  it('only reads the frontmatter, not a model: line in the prose below it', () => {
    agent('a.md', '---\nmodel: real/one\n---\n\nDo not use model: fake/two in your answer.\n');
    expect(subagentModels(dir)).toEqual(['real/one']);
  });

  it('ignores an alias that is not a vendor/model id', () => {
    // `sonnet` and friends resolve through the harness, not the gateway, so a
    // pin cannot be built for them and must not be attempted.
    agent('a.md', '---\nmodel: sonnet\n---\n');
    agent('b.md', '---\nmodel: real/one\n---\n');
    expect(subagentModels(dir)).toEqual(['real/one']);
  });

  it('returns nothing for a group with no agents directory', () => {
    expect(subagentModels(path.join(dir, 'nope'))).toEqual([]);
  });

  it('skips a malformed file rather than failing the whole scan', () => {
    agent('bad.md', 'no frontmatter here\n');
    agent('good.md', '---\nmodel: real/one\n---\n');
    expect(subagentModels(dir)).toEqual(['real/one']);
  });
});
