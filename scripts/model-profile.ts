/**
 * Model profiles — save and switch the whole LLM routing of this install in
 * one step.
 *
 * A profile captures everything that decides which API and which models the
 * agents use:
 *
 *   - `.env` `ANTHROPIC_BASE_URL` (install-wide; `null` = Anthropic direct,
 *     the line is commented out, never deleted)
 *   - per agent group: `container_configs.model` / `.effort` (via `ncl`)
 *   - per file subagent: the `model:` / `effort:` frontmatter lines of
 *     `groups/<folder>/.claude/agents/<name>.md`
 *
 * Profiles live in `config/model-profiles/<name>.json`, keyed by group folder.
 * Credentials are not part of a profile: OneCLI picks the secret by host
 * pattern, so an agent that has both the Anthropic and the OpenRouter secret
 * assigned works under either profile.
 *
 * Usage (from the repo root):
 *   pnpm exec tsx scripts/model-profile.ts list
 *   pnpm exec tsx scripts/model-profile.ts show
 *   pnpm exec tsx scripts/model-profile.ts save <name> [--force]
 *   pnpm exec tsx scripts/model-profile.ts apply <name> [--dry-run]
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface ModelEffort {
  model: string | null;
  effort: string | null;
}

export interface GroupProfile extends ModelEffort {
  subagents?: Record<string, ModelEffort>;
}

export interface ModelProfile {
  description?: string;
  /** `null` = Anthropic direct (no `ANTHROPIC_BASE_URL`). */
  anthropicBaseUrl: string | null;
  /** Keyed by agent group folder. */
  groups: Record<string, GroupProfile>;
}

const ENV_KEY = 'ANTHROPIC_BASE_URL';
const ACTIVE_RE = new RegExp(`^\\s*${ENV_KEY}\\s*=(.*)$`);
const COMMENTED_RE = new RegExp(`^\\s*#\\s*${ENV_KEY}\\s*=(.*)$`);

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** The active `ANTHROPIC_BASE_URL`, read the way `src/env.ts` reads it. */
export function readEnvBaseUrl(content: string): string | null {
  for (const line of content.split('\n')) {
    const m = ACTIVE_RE.exec(line);
    if (m) return unquote(m[1]) || null;
  }
  return null;
}

/**
 * Set or comment out `ANTHROPIC_BASE_URL`. Only that one line is ever touched,
 * and no line is ever deleted: switching off comments it out, switching on
 * reuses the commented line so a round trip restores the file byte for byte.
 */
export function setEnvBaseUrl(content: string, baseUrl: string | null): string {
  const lines = content.split('\n');
  const active = lines.findIndex((l) => ACTIVE_RE.test(l));

  if (baseUrl === null) {
    if (active === -1) return content;
    lines[active] = `# ${lines[active].trimStart()}`;
    return lines.join('\n');
  }

  const wanted = `${ENV_KEY}=${baseUrl}`;
  if (active !== -1) {
    if (unquote(ACTIVE_RE.exec(lines[active])![1]) === baseUrl) return content;
    lines[active] = wanted;
    return lines.join('\n');
  }
  const commented = lines.findIndex((l) => {
    const m = COMMENTED_RE.exec(l);
    return m !== null && unquote(m[1]) === baseUrl;
  });
  if (commented !== -1) {
    lines[commented] = wanted;
    return lines.join('\n');
  }
  if (content === '' || content.endsWith('\n')) return `${content}${wanted}\n`;
  return `${content}\n${wanted}\n`;
}

/** Index of the closing `---` of the leading frontmatter block, or -1. */
function frontmatterEnd(lines: string[]): number {
  if (lines[0] !== '---') return -1;
  return lines.indexOf('---', 1);
}

export function readFrontmatter(md: string): ModelEffort {
  const lines = md.split('\n');
  const end = frontmatterEnd(lines);
  const out: ModelEffort = { model: null, effort: null };
  if (end === -1) return out;
  for (const line of lines.slice(1, end)) {
    const m = /^(model|effort):\s*(\S+)\s*$/.exec(line);
    if (m) out[m[1] as 'model' | 'effort'] = m[2];
  }
  return out;
}

/** Rewrite only the `model:` / `effort:` frontmatter lines; the body is never touched. */
export function setFrontmatter(md: string, want: ModelEffort): string {
  const lines = md.split('\n');
  let end = frontmatterEnd(lines);
  if (end === -1) throw new Error('no frontmatter block');

  const find = (key: string) => lines.slice(0, end).findIndex((l, i) => i > 0 && l.startsWith(`${key}:`));

  let modelIdx = find('model');
  if (want.model === null) {
    if (modelIdx !== -1) {
      lines.splice(modelIdx, 1);
      end--;
    }
  } else if (modelIdx !== -1) {
    lines[modelIdx] = `model: ${want.model}`;
  } else {
    lines.splice(end, 0, `model: ${want.model}`);
    modelIdx = end;
    end++;
  }

  const effortIdx = find('effort');
  if (want.effort === null) {
    if (effortIdx !== -1) lines.splice(effortIdx, 1);
  } else if (effortIdx !== -1) {
    lines[effortIdx] = `effort: ${want.effort}`;
  } else {
    const at = modelIdx !== -1 && want.model !== null ? modelIdx + 1 : end;
    lines.splice(at, 0, `effort: ${want.effort}`);
  }
  return lines.join('\n');
}

const show = (v: string | null) => v ?? '(unset)';

/** Human-readable list of everything `apply` would change to get from `live` to `target`. */
export function diffProfiles(live: ModelProfile, target: ModelProfile): string[] {
  const out: string[] = [];
  if (live.anthropicBaseUrl !== target.anthropicBaseUrl) {
    const fmt = (v: string | null) => v ?? 'Anthropic direct';
    out.push(`.env ${ENV_KEY}: ${fmt(live.anthropicBaseUrl)} -> ${fmt(target.anthropicBaseUrl)}`);
  }
  for (const [folder, want] of Object.entries(target.groups)) {
    const have = live.groups[folder] ?? { model: null, effort: null, subagents: {} };
    for (const key of ['model', 'effort'] as const) {
      if (have[key] !== want[key]) out.push(`${folder} ${key}: ${show(have[key])} -> ${show(want[key])}`);
    }
    for (const [name, sub] of Object.entries(want.subagents ?? {})) {
      const cur = have.subagents?.[name] ?? { model: null, effort: null };
      for (const key of ['model', 'effort'] as const) {
        if (cur[key] !== sub[key]) out.push(`${folder}/${name} ${key}: ${show(cur[key])} -> ${show(sub[key])}`);
      }
    }
  }
  return out;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PROFILE_DIR = path.join(ROOT, 'config', 'model-profiles');
const ENV_FILE = path.join(ROOT, '.env');
const NCL = path.join(ROOT, 'bin', 'ncl');

function ncl(args: string[]): unknown {
  const raw = execFileSync(NCL, [...args, '--json'], { cwd: ROOT, encoding: 'utf-8' });
  const parsed = JSON.parse(raw) as { ok: boolean; data?: unknown; error?: unknown };
  if (!parsed.ok) throw new Error(`ncl ${args.join(' ')} failed: ${JSON.stringify(parsed.error)}`);
  return parsed.data;
}

function agentsDir(folder: string): string {
  return path.join(ROOT, 'groups', folder, '.claude', 'agents');
}

function groupIds(): Map<string, string> {
  const rows = ncl(['groups', 'list']) as { id: string; folder: string }[];
  return new Map(rows.map((r) => [r.folder, r.id]));
}

function readLive(): ModelProfile {
  const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
  const live: ModelProfile = { anthropicBaseUrl: readEnvBaseUrl(env), groups: {} };
  for (const [folder, id] of groupIds()) {
    const cfg = ncl(['groups', 'config', 'get', '--id', id]) as { model: string | null; effort: string | null };
    const group: GroupProfile = { model: cfg.model ?? null, effort: cfg.effort ?? null };
    const dir = agentsDir(folder);
    if (fs.existsSync(dir)) {
      const subs: Record<string, ModelEffort> = {};
      for (const file of fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()) {
        subs[file.slice(0, -3)] = readFrontmatter(fs.readFileSync(path.join(dir, file), 'utf-8'));
      }
      if (Object.keys(subs).length > 0) group.subagents = subs;
    }
    live.groups[folder] = group;
  }
  return live;
}

function profilePath(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`invalid profile name: ${name}`);
  return path.join(PROFILE_DIR, `${name}.json`);
}

function loadProfile(name: string): ModelProfile {
  const p = profilePath(name);
  if (!fs.existsSync(p)) throw new Error(`no such profile: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ModelProfile;
}

function listProfiles(): string[] {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  return fs
    .readdirSync(PROFILE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o644 });
  fs.renameSync(tmp, file);
}

function apply(name: string, dryRun: boolean): void {
  const target = loadProfile(name);
  const live = readLive();
  const changes = diffProfiles(live, target);
  if (changes.length === 0) {
    console.log(`Already on profile "${name}" — nothing to change.`);
    return;
  }
  console.log(`Profile "${name}" changes:`);
  for (const c of changes) console.log(`  ${c}`);
  if (dryRun) {
    console.log('(dry run — nothing written)');
    return;
  }

  const ids = groupIds();
  for (const folder of Object.keys(target.groups)) {
    if (!ids.has(folder)) throw new Error(`profile names unknown group folder: ${folder}`);
    for (const sub of Object.keys(target.groups[folder].subagents ?? {})) {
      const file = path.join(agentsDir(folder), `${sub}.md`);
      if (!fs.existsSync(file)) throw new Error(`profile names missing subagent file: ${file}`);
    }
  }

  if (live.anthropicBaseUrl !== target.anthropicBaseUrl) {
    const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
    writeAtomic(ENV_FILE, setEnvBaseUrl(env, target.anthropicBaseUrl));
  }

  for (const [folder, want] of Object.entries(target.groups)) {
    const id = ids.get(folder)!;
    const args = ['groups', 'config', 'update', '--id', id];
    if (want.model !== null) args.push('--model', want.model);
    if (want.effort !== null) args.push('--effort', want.effort);
    if (args.length > 5) ncl(args);
    for (const [sub, se] of Object.entries(want.subagents ?? {})) {
      const file = path.join(agentsDir(folder), `${sub}.md`);
      const before = fs.readFileSync(file, 'utf-8');
      const after = setFrontmatter(before, se);
      if (after !== before) writeAtomic(file, after);
    }
    ncl(['groups', 'restart', '--id', id]);
    console.log(`Restarted ${folder} (${id}).`);
  }
  console.log(`Profile "${name}" applied. New containers pick it up on their next message.`);
}

function main(argv: string[]): void {
  const [verb, name, ...rest] = argv;
  const flags = new Set(rest.concat(name?.startsWith('--') ? [name] : []));
  switch (verb) {
    case 'list':
      for (const p of listProfiles()) console.log(p);
      return;
    case 'show': {
      const live = readLive();
      console.log(JSON.stringify(live, null, 2));
      const matches = listProfiles().filter((p) => diffProfiles(live, loadProfile(p)).length === 0);
      console.log(matches.length ? `Matches profile: ${matches.join(', ')}` : 'Matches no saved profile.');
      return;
    }
    case 'save': {
      if (!name || name.startsWith('--')) throw new Error('usage: save <name> [--force]');
      const file = profilePath(name);
      if (fs.existsSync(file) && !flags.has('--force')) throw new Error(`${file} exists — pass --force to overwrite`);
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      const live = readLive();
      fs.writeFileSync(file, `${JSON.stringify({ description: '', ...live }, null, 2)}\n`);
      console.log(`Saved live state to ${path.relative(ROOT, file)}.`);
      return;
    }
    case 'apply':
      if (!name || name.startsWith('--')) throw new Error('usage: apply <name> [--dry-run]');
      apply(name, flags.has('--dry-run'));
      return;
    default:
      console.error('usage: model-profile.ts list | show | save <name> [--force] | apply <name> [--dry-run]');
      process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
