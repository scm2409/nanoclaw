import { describe, it, expect } from 'vitest';
import { resolveClaudeContainerEnv } from './claude.js';

describe('resolveClaudeContainerEnv', () => {
  it('passes a custom endpoint plus a placeholder token', () => {
    const env = resolveClaudeContainerEnv({}, { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder');
  });

  it('passes nothing when no custom endpoint is configured', () => {
    expect(resolveClaudeContainerEnv({}, {})).toEqual({});
  });

  it('forwards the auto-compact window from the host process env', () => {
    const env = resolveClaudeContainerEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, {});
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
  });

  it('forwards the auto-compact window from .env', () => {
    const env = resolveClaudeContainerEnv({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' });
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('900000');
  });

  it('lets the process env win over .env', () => {
    const env = resolveClaudeContainerEnv(
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' },
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' },
    );
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
  });

  it('drops a non-numeric window rather than passing garbage to the SDK', () => {
    const env = resolveClaudeContainerEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1M' }, {});
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  it('drops a zero or negative window', () => {
    expect(
      resolveClaudeContainerEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '0' }, {}).CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    ).toBeUndefined();
    expect(
      resolveClaudeContainerEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '-1' }, {}).CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    ).toBeUndefined();
  });

  it('carries the window even without a custom endpoint', () => {
    const env = resolveClaudeContainerEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, {});
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
  });
});
