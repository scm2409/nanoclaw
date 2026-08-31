import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildModelAliasEnv } from './claude.js';

// The Claude Code harness makes internal calls addressed by the `sonnet` /
// `haiku` / `opus` / `fable` alias even when the main model and every subagent
// model are set explicitly. Behind an OpenRouter-style proxy an un-remapped
// alias is a live, billed call to a real Anthropic model the operator never
// chose. buildModelAliasEnv pins each alias to a model the group already runs.

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-env-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeAgentFile(name: string, model: string): void {
  const dir = path.join(tmp, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\ndescription: ${name} subagent.\nmodel: ${model}\n---\n\nBody for ${name}.\n`,
  );
}

describe('buildModelAliasEnv', () => {
  it('returns nothing for a bare Anthropic alias main model', () => {
    expect(buildModelAliasEnv('sonnet', tmp)).toEqual({});
  });

  it('returns nothing for a claude-* id main model', () => {
    expect(buildModelAliasEnv('claude-sonnet-5', tmp)).toEqual({});
  });

  it('returns nothing when no main model is set', () => {
    expect(buildModelAliasEnv(undefined, tmp)).toEqual({});
  });

  it('maps every alias to a group model for a vendor/slug main model', () => {
    writeAgentFile('coder', 'z-ai/glm-5.3-flash');
    writeAgentFile('smart', 'openai/gpt-5.6-sol');

    expect(buildModelAliasEnv('google/gemini-3.7-flash', tmp)).toEqual({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'google/gemini-3.7-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-5.3-flash',
      ANTHROPIC_SMALL_FAST_MODEL: 'z-ai/glm-5.3-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'openai/gpt-5.6-sol',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'moonshotai/kimi-k3',
    });
  });

  it('falls back to the main model when coder/smart are absent', () => {
    const env = buildModelAliasEnv('google/gemini-3.7-flash', tmp);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('google/gemini-3.7-flash');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('google/gemini-3.7-flash');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('google/gemini-3.7-flash');
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('moonshotai/kimi-k3');
  });

  it('ignores a subagent whose model is itself a bare alias', () => {
    writeAgentFile('coder', 'haiku');
    const env = buildModelAliasEnv('google/gemini-3.7-flash', tmp);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('google/gemini-3.7-flash');
  });
});
