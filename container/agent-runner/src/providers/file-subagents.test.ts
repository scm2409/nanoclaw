import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadFileSubagents } from './file-subagents.js';

// Regression test: the Claude Agent SDK / claude CLI does NOT auto-discover
// .claude/agents/*.md files when run headlessly (verified empirically against
// the real CLI: `claude -p ... --setting-sources project,user,local` never
// lists a subagent defined only as a markdown file on disk, with clean
// minimal frontmatter, from ANY cwd — only the programmatic `agents` option
// registers one). Every subagent file NanoClaw ships (e.g. websearch.md) was
// silently unusable via the Task tool until this reads them itself.

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-subagents-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeAgentFile(name: string, content: string): void {
  const dir = path.join(tmp, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
}

describe('loadFileSubagents', () => {
  it('parses a well-formed agent file into an AgentDefinition', () => {
    writeAgentFile(
      'websearch',
      `---
description: Recherchiert im Web und liefert eine Zusammenfassung.
model: haiku
tools: [WebSearch, WebFetch]
---

Du bist ein Recherche-Agent.
Suche gezielt und fasse zusammen.
`,
    );

    const agents = loadFileSubagents(tmp);

    expect(Object.keys(agents)).toEqual(['websearch']);
    expect(agents.websearch).toEqual({
      description: 'Recherchiert im Web und liefert eine Zusammenfassung.',
      model: 'haiku',
      tools: ['WebSearch', 'WebFetch'],
      prompt: 'Du bist ein Recherche-Agent.\nSuche gezielt und fasse zusammen.',
    });
  });

  it('parses model and reasoning effort overrides', () => {
    writeAgentFile(
      'smart',
      // Frontmatter must start at column 0, the way a real .claude/agents/*.md
      // file is written — both the delimiter and the field regexes are anchored
      // to the start of a line, so an indented block parses as no agent at all.
      `---
description: A smart agent.
model: openai/gpt-5.6-sol
effort: high
---

Think carefully.
`,
    );

    expect(loadFileSubagents(tmp).smart).toEqual({
      description: 'A smart agent.',
      model: 'openai/gpt-5.6-sol',
      effort: 'high',
      prompt: 'Think carefully.',
    });
  });

  it('parses a file with no model/tools fields (both optional)', () => {
    writeAgentFile(
      'plain',
      `---
description: A minimal agent.
---

Just say hello.
`,
    );

    const agents = loadFileSubagents(tmp);

    expect(agents.plain).toEqual({ description: 'A minimal agent.', prompt: 'Just say hello.' });
  });

  it('returns an empty map when .claude/agents does not exist', () => {
    expect(loadFileSubagents(tmp)).toEqual({});
  });

  it('returns an empty map when .claude/agents is empty', () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'agents'), { recursive: true });
    expect(loadFileSubagents(tmp)).toEqual({});
  });

  it('skips a file with no frontmatter delimiters instead of throwing', () => {
    writeAgentFile('broken', 'Just plain text, no frontmatter at all.');
    expect(loadFileSubagents(tmp)).toEqual({});
  });

  it('skips a file missing the required description field', () => {
    writeAgentFile(
      'nodescription',
      `---
model: haiku
---

Body text.
`,
    );
    expect(loadFileSubagents(tmp)).toEqual({});
  });

  it('skips a file with an empty body (no prompt)', () => {
    writeAgentFile(
      'empty',
      `---
description: Has a description but no body.
---
`,
    );
    expect(loadFileSubagents(tmp)).toEqual({});
  });

  it('loads multiple agent files, one bad file does not break the others', () => {
    writeAgentFile(
      'good-one',
      `---
description: First good agent.
---

Body one.
`,
    );
    writeAgentFile('broken', 'no frontmatter here');
    writeAgentFile(
      'good-two',
      `---
description: Second good agent.
---

Body two.
`,
    );

    const agents = loadFileSubagents(tmp);

    expect(Object.keys(agents).sort()).toEqual(['good-one', 'good-two']);
  });

  it('ignores non-.md files in the agents directory', () => {
    const dir = path.join(tmp, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.txt'), 'not an agent file');
    expect(loadFileSubagents(tmp)).toEqual({});
  });

  // An MCP server withheld from the main agent (marked `subagentOnly` in
  // container.json) is only reachable if some subagent claims it by name here.
  // The claim is a list of server *names*; resolving them to configs is
  // claude.ts's job, because only it holds the full server map.
  it('parses the mcpServers claim and the skills preload list', () => {
    writeAgentFile(
      'nextcloud',
      `---
description: Runs Nextcloud operations.
model: sonnet
tools: [Read, Skill]
mcpServers: [nextcloud]
skills: [nextcloud-deck-workflow, nextcloud-deck-inbox]
---

Du bist ein Nextcloud-Ausführer.
`,
    );

    const agents = loadFileSubagents(tmp);

    expect(agents.nextcloud).toEqual({
      description: 'Runs Nextcloud operations.',
      model: 'sonnet',
      tools: ['Read', 'Skill'],
      mcpServers: ['nextcloud'],
      skills: ['nextcloud-deck-workflow', 'nextcloud-deck-inbox'],
      prompt: 'Du bist ein Nextcloud-Ausführer.',
    });
  });

  it('leaves mcpServers and skills undefined when the lists are empty', () => {
    writeAgentFile(
      'blank-lists',
      `---
description: Declares empty lists.
mcpServers: []
skills: []
---

Body.
`,
    );

    expect(loadFileSubagents(tmp)['blank-lists']).toEqual({
      description: 'Declares empty lists.',
      prompt: 'Body.',
    });
  });
});
