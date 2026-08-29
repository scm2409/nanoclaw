/**
 * Reads `.claude/agents/*.md` subagent definitions from a group's workspace
 * and returns them as SDK `AgentDefinition`-shaped objects.
 *
 * Necessary because the Claude Agent SDK / claude CLI does NOT auto-discover
 * these files when run headlessly — verified empirically against the real
 * CLI binary: `claude -p ... --setting-sources project,user,local` never
 * lists a subagent defined only as a markdown file on disk (clean minimal
 * frontmatter, correct cwd) as an available Task-tool subagent_type. Only
 * the programmatic `agents` option (or the CLI's `--agents` flag) actually
 * registers one — filesystem auto-discovery of `.claude/agents/` appears to
 * be an interactive-TUI-only behavior. Every NanoClaw-shipped subagent file
 * (e.g. a group's websearch.md) was silently unusable via the Task tool
 * until the caller reads them itself and passes the result through
 * `Options.agents`.
 */
import fs from 'fs';
import path from 'path';

export interface FileSubagentDefinition {
  description: string;
  prompt: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number;
  tools?: string[];
  /**
   * Names of MCP servers this subagent claims. Resolution to actual server
   * configs happens in the provider, which is the only place holding the full
   * server map. A server marked `subagentOnly` in container.json is withheld
   * from the main thread and is reachable *only* through a claim like this.
   */
  mcpServers?: string[];
  /** Skill names preloaded into the subagent's context (SDK `AgentDefinition.skills`). */
  skills?: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const FIELD_RE = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/;

/** Parse an inline `[a, b, c]` frontmatter list. Anything else yields undefined. */
function parseList(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.startsWith('[') || !raw.endsWith(']')) return undefined;
  const items = raw
    .slice(1, -1)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseAgentMarkdown(raw: string): FileSubagentDefinition | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const [, frontmatter, body] = match;

  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const m = FIELD_RE.exec(line);
    if (!m) continue;
    fields[m[1]] = m[2].trim();
  }

  const description = fields.description;
  if (!description) return null;

  const prompt = body.trim();
  if (!prompt) return null;

  const def: FileSubagentDefinition = { description, prompt };
  if (fields.model) def.model = fields.model;
  if (fields.effort) {
    const effort = fields.effort;
    if (/^(low|medium|high|xhigh|max)$/.test(effort)) {
      def.effort = effort as FileSubagentDefinition['effort'];
    } else if (/^\d+$/.test(effort)) {
      def.effort = Number(effort);
    }
  }

  const tools = parseList(fields.tools);
  if (tools) def.tools = tools;

  const mcpServers = parseList(fields.mcpServers);
  if (mcpServers) def.mcpServers = mcpServers;

  const skills = parseList(fields.skills);
  if (skills) def.skills = skills;

  return def;
}

/**
 * Load every `.claude/agents/*.md` file under `cwd` into a name -> definition
 * map. Best-effort: a missing directory, an empty directory, or a malformed
 * individual file all degrade to "skip it" rather than throwing — one bad
 * file must never take down subagent loading for the rest of the group.
 */
export function loadFileSubagents(cwd: string): Record<string, FileSubagentDefinition> {
  const dir = path.join(cwd, '.claude', 'agents');
  const result: Record<string, FileSubagentDefinition> = {};

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return result;
  }

  for (const file of entries) {
    const name = file.slice(0, -3);
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const parsed = parseAgentMarkdown(raw);
      if (parsed) result[name] = parsed;
    } catch {
      // Best-effort — an unreadable file just doesn't contribute an agent.
    }
  }

  return result;
}
