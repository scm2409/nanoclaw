import { describe, it, expect } from 'vitest';

import {
  diffProfiles,
  readEnvBaseUrl,
  readFrontmatter,
  setEnvBaseUrl,
  setFrontmatter,
  type ModelProfile,
} from './model-profile.js';

const ENV = [
  'ONECLI_URL=http://172.17.0.1:10254',
  'DEFAULT_AGENT_PROVIDER=claude',
  '',
  'ANTHROPIC_BASE_URL=https://openrouter.ai/api',
  'OTHER=1',
  '',
].join('\n');

describe('env base URL', () => {
  it('reads the active line and ignores commented ones', () => {
    expect(readEnvBaseUrl(ENV)).toBe('https://openrouter.ai/api');
    expect(readEnvBaseUrl('# ANTHROPIC_BASE_URL=https://openrouter.ai/api\n')).toBeNull();
    expect(readEnvBaseUrl('FOO=1\n')).toBeNull();
  });

  it('comments the line out for Anthropic direct, touching nothing else', () => {
    const out = setEnvBaseUrl(ENV, null);
    expect(readEnvBaseUrl(out)).toBeNull();
    expect(out).toContain('# ANTHROPIC_BASE_URL=https://openrouter.ai/api');
    const other = (s: string) => s.split('\n').filter((l) => !l.includes('ANTHROPIC_BASE_URL'));
    expect(other(out)).toEqual(other(ENV));
  });

  it('round-trips back to the original file byte for byte', () => {
    const off = setEnvBaseUrl(ENV, null);
    expect(setEnvBaseUrl(off, 'https://openrouter.ai/api')).toBe(ENV);
  });

  it('is idempotent in both directions', () => {
    const off = setEnvBaseUrl(ENV, null);
    expect(setEnvBaseUrl(off, null)).toBe(off);
    expect(setEnvBaseUrl(ENV, 'https://openrouter.ai/api')).toBe(ENV);
  });

  it('changes the value of an active line in place', () => {
    const out = setEnvBaseUrl(ENV, 'https://example.test/api');
    expect(readEnvBaseUrl(out)).toBe('https://example.test/api');
    expect(out.split('\n').length).toBe(ENV.split('\n').length);
  });

  it('appends a line when none exists, keeping the trailing newline', () => {
    const out = setEnvBaseUrl('FOO=1\n', 'https://openrouter.ai/api');
    expect(out).toBe('FOO=1\nANTHROPIC_BASE_URL=https://openrouter.ai/api\n');
  });

  it('never deletes a line', () => {
    expect(setEnvBaseUrl('FOO=1\n', null)).toBe('FOO=1\n');
  });
});

const AGENT = [
  '---',
  'description: Does things. model: not-this-one',
  'model: z-ai/glm-5.3-flash',
  'effort: low',
  'tools: [Bash, Read]',
  '---',
  '',
  'Body mentions model: foo and effort: bar and must stay.',
  '',
].join('\n');

describe('subagent frontmatter', () => {
  it('reads model and effort from the frontmatter only', () => {
    expect(readFrontmatter(AGENT)).toEqual({ model: 'z-ai/glm-5.3-flash', effort: 'low' });
  });

  it('rewrites model and effort and leaves every other line alone', () => {
    const out = setFrontmatter(AGENT, { model: 'claude-sonnet-5', effort: 'high' });
    expect(readFrontmatter(out)).toEqual({ model: 'claude-sonnet-5', effort: 'high' });
    const a = AGENT.split('\n');
    const b = out.split('\n');
    expect(b.length).toBe(a.length);
    expect(b.filter((_, i) => i !== 2 && i !== 3)).toEqual(a.filter((_, i) => i !== 2 && i !== 3));
  });

  it('inserts effort after model when missing and removes it when null', () => {
    const noEffort = AGENT.replace('effort: low\n', '');
    const added = setFrontmatter(noEffort, { model: 'claude-opus-5-5', effort: 'high' });
    expect(added.split('\n')[3]).toBe('effort: high');
    const removed = setFrontmatter(AGENT, { model: 'claude-opus-5-5', effort: null });
    expect(readFrontmatter(removed)).toEqual({ model: 'claude-opus-5-5', effort: null });
    expect(removed).not.toMatch(/^effort:/m);
  });

  it('refuses a file without frontmatter', () => {
    expect(() => setFrontmatter('no frontmatter\n', { model: 'x', effort: null })).toThrow();
  });
});

describe('diffProfiles', () => {
  const base: ModelProfile = {
    anthropicBaseUrl: 'https://openrouter.ai/api',
    groups: {
      'main-agent': {
        model: 'z-ai/glm-5.3-flash',
        effort: 'medium',
        subagents: { coder: { model: 'z-ai/glm-5.3-flash', effort: 'low' } },
      },
    },
  };

  it('is empty for identical profiles', () => {
    expect(diffProfiles(base, structuredClone(base))).toEqual([]);
  });

  it('names every changed field', () => {
    const target = structuredClone(base);
    target.anthropicBaseUrl = null;
    target.groups['main-agent'].model = 'claude-sonnet-5';
    target.groups['main-agent'].subagents!.coder.effort = 'high';
    const lines = diffProfiles(base, target);
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toMatch(/ANTHROPIC_BASE_URL.*openrouter.*Anthropic direct/);
    expect(lines.join('\n')).toMatch(/main-agent model: z-ai\/glm-5.3-flash -> claude-sonnet-5/);
    expect(lines.join('\n')).toMatch(/main-agent\/coder effort: low -> high/);
  });
});
