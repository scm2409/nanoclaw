#!/usr/bin/env node
/**
 * Enforces the fork-changelog invariant for this repo (a fork of
 * nanocoai/nanoclaw): any session that changes the fork must describe that
 * change in FORK-CHANGELOG.md before it ends. See docs/fork-changelog.md.
 *
 * Three modes, dispatched by argv[2] — all read-only w.r.t. the repo's
 * tracked content; the only thing this script writes is its own gitignored
 * state under .tmp-fork-changelog/:
 *
 *   session-start   SessionStart hook. Records this work item's baseline
 *                   (HEAD sha, a hash of FORK-CHANGELOG.md, the model in use)
 *                   so later modes can tell what changed since. Also prints
 *                   the convention as session context (plain stdout, which
 *                   Claude Code adds automatically for SessionStart).
 *
 *   record-edit     PostToolUse hook on Write|Edit|MultiEdit|NotebookEdit.
 *                   Records which repo-relative paths Claude actually wrote,
 *                   so the Stop check has a signal that doesn't depend on a
 *                   commit having happened yet.
 *
 *   stop            Stop hook. Blocks the turn from ending
 *                   (`{"decision":"block"}` on exit 0 — the documented way to
 *                   keep Claude going) if the session changed the fork but
 *                   FORK-CHANGELOG.md doesn't show it.
 *
 * Why both edits and commits are tracked: commits need the human's approval
 * (per project convention), so the typical session ends with real edits and
 * *no* new commit. Gating on `nanoclaw-upstream/main..HEAD` alone would never
 * fire for that — the common case — so the primary signal is "Claude wrote a
 * non-exempt file this session", checked by comparing FORK-CHANGELOG.md's
 * content hash at session start vs. now. Commit tracking is layered on top
 * only to demand that, once commits exist, their SHAs are actually named.
 *
 * The gate is satisfiable by a file edit alone — it never asks Claude to
 * commit, and it reads the working tree, not HEAD.
 *
 * Fails open on anything unexpected: not a git repo, hook errors, first-ever
 * stop with no recorded baseline, etc. A misconfigured environment must never
 * hang a session.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_REF = 'nanoclaw-upstream/main';
const CHANGELOG_NAME = 'FORK-CHANGELOG.md';
const STATE_DIR = '.tmp-fork-changelog'; // matched by the repo's existing `.tmp-*` gitignore entry
const MAX_BLOCKS = 3; // give up after this many reminders in one turn and just warn the user instead

const mode = process.argv[2];

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function projectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function tryGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function exitOpen() {
  process.exit(0);
}

function statePathFor(root, sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(root, STATE_DIR, `${safe}.json`);
}

function loadState(root, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePathFor(root, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function saveState(root, sessionId, state) {
  const dir = path.join(root, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePathFor(root, sessionId), JSON.stringify(state, null, 2));
}

function changelogHash(root) {
  const p = path.join(root, CHANGELOG_NAME);
  if (!fs.existsSync(p)) return null;
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function freshState(root, sessionId, model) {
  return {
    sessionId,
    baselineSha: tryGit(['rev-parse', 'HEAD'], root),
    logHash: changelogHash(root),
    model: model || null,
    edited: [],
    blocks: 0,
  };
}

/* ---------- session-start: record baseline, inject convention ---------- */

function sessionStart(root, input) {
  const sessionId = input.session_id;
  const source = input.source || 'startup';
  const prior = loadState(root, sessionId);

  // /compact and --resume continue the SAME work item — don't reset the
  // baseline mid-item, or earlier edits/commits stop being demanded.
  const keepBaseline = prior && (source === 'resume' || source === 'compact');
  const state = keepBaseline
    ? { ...prior, model: input.model || prior.model }
    : freshState(root, sessionId, input.model);
  saveState(root, sessionId, state);

  const model = input.model || state.model || '(model name unavailable this session)';
  process.stdout.write(
    [
      `Fork convention: this repo is a fork of nanocoai/nanoclaw. Any fork-local change made`,
      `this session must be described in ${CHANGELOG_NAME} before the session ends (a Stop`,
      `hook checks this) — never in upstream's CHANGELOG.md. One entry per work item, newest`,
      `first:`,
      ``,
      `  ## <YYYY-MM-DD> — <short title>`,
      `  <what changed and why, in prose>`,
      `  Commits: <sha or A..B, inclusive of both ends> · vibecoded with ${model}`,
      ``,
      `Write the entry as part of the work, before asking to commit. See docs/fork-changelog.md.`,
    ].join('\n')
  );
}

/* ---------- record-edit: track what Claude wrote ---------- */

function recordEdit(root, input) {
  const sessionId = input.session_id;
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.notebook_path;
  if (!target) return;

  const abs = path.resolve(root, target);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) return; // outside the repo
  if (rel === CHANGELOG_NAME) return; // writing the changelog itself isn't "work" to log
  if (rel.split(path.sep)[0] === STATE_DIR) return;

  const state = loadState(root, sessionId) || freshState(root, sessionId, null);
  if (!state.edited.includes(rel)) {
    state.edited.push(rel);
    saveState(root, sessionId, state);
  }
}

/* ---------- stop: the gate ---------- */

function ignoredPaths(root, relPaths) {
  if (relPaths.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: root,
      input: relPaths.join('\n'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch (err) {
    // git check-ignore exits 1 when nothing matches; stdout may still hold matches.
    const out = (err && err.stdout) || '';
    return new Set(String(out).split('\n').filter(Boolean));
  }
}

function newCommits(root, baselineSha) {
  if (!baselineSha) return [];
  const head = tryGit(['rev-parse', 'HEAD'], root);
  if (!head || head === baselineSha) return [];
  // Amend/rebase can make the baseline unreachable from HEAD; drop the
  // commit-coverage requirement rather than demand vanished shas.
  if (tryGit(['merge-base', '--is-ancestor', baselineSha, 'HEAD'], root) === null) return [];
  const out = tryGit(['log', '--reverse', '--format=%H\t%s', `${baselineSha}..HEAD`], root);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

// Every bare sha and every `a..b` range in the changelog, expanded to full
// shas. Ranges are read inclusively of `a` (unlike git's own `a..b`), since
// that's how "Commits: X..Y" reads in prose.
function coveredShas(root, text) {
  const covered = new Set();
  for (const m of text.matchAll(/\b([0-9a-f]{7,40})\b(?:\.\.([0-9a-f]{7,40})\b)?/gi)) {
    const [, a, b] = m;
    const fullA = tryGit(['rev-parse', '--verify', '--quiet', `${a}^{commit}`], root);
    if (fullA) covered.add(fullA);
    if (b) {
      const expanded =
        tryGit(['rev-list', `${a}~1..${b}`], root) ?? tryGit(['rev-list', `${a}..${b}`], root);
      if (expanded) for (const sha of expanded.split('\n').filter(Boolean)) covered.add(sha);
    }
  }
  return covered;
}

function stop(root, input) {
  const sessionId = input.session_id;
  const state = loadState(root, sessionId);

  // No recorded baseline (hook just installed, or an old resumed session
  // from before it existed) — record one now and let this stop through.
  if (!state) {
    saveState(root, sessionId, freshState(root, sessionId, null));
    exitOpen();
  }

  const commits = newCommits(root, state.baselineSha);

  const ignored = ignoredPaths(root, state.edited || []);
  const editedFiles = (state.edited || []).filter((p) => !ignored.has(p));

  if (commits.length === 0 && editedFiles.length === 0) exitOpen(); // nothing to log

  const currentHash = changelogHash(root);
  const logChanged = currentHash !== state.logHash;

  const changelogPath = path.join(root, CHANGELOG_NAME);
  const text = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  const covered = commits.length ? coveredShas(root, text) : new Set();
  const uncoveredCommits = commits.filter(({ sha }) => !covered.has(sha));

  const commitsOk = commits.length === 0 || uncoveredCommits.length === 0;
  // An edits-only session (no commits) can only pass by actually changing the
  // changelog — there's nothing else to check it against.
  const editsOk = editedFiles.length === 0 ? true : logChanged;

  if (commitsOk && editsOk) exitOpen();

  state.blocks = (state.blocks || 0) + 1;
  if (state.blocks > MAX_BLOCKS) {
    saveState(root, sessionId, { ...state, blocks: 0 });
    console.log(
      JSON.stringify({
        systemMessage: `${CHANGELOG_NAME} still doesn't cover this session's changes after ${MAX_BLOCKS} reminders — letting the turn end. Please check it by hand, or set FORK_CHANGELOG_SKIP=1 to silence this.`,
      })
    );
    exitOpen();
  }
  saveState(root, sessionId, state);

  const lines = [];
  lines.push(`This session changed the fork but ${CHANGELOG_NAME} doesn't describe it yet.`);
  lines.push('');
  if (editedFiles.length) {
    lines.push(`Files written this session (${editedFiles.length}):`);
    for (const p of editedFiles.slice(0, 20)) lines.push(`  ${p}`);
    if (editedFiles.length > 20) lines.push(`  … and ${editedFiles.length - 20} more`);
    lines.push('');
  }
  if (commits.length) {
    lines.push(`New commits since this work item started (${commits.length}):`);
    for (const { sha, subject } of commits) lines.push(`  ${sha.slice(0, 7)} ${subject}`);
    if (uncoveredCommits.length) {
      const range = `${commits[0].sha.slice(0, 7)}..${commits[commits.length - 1].sha.slice(0, 7)}`;
      lines.push(
        `${uncoveredCommits.length} of them aren't named or covered by a range in ${CHANGELOG_NAME}. A ` +
          `'Commits: ${range}' line covers all of them (ranges are read inclusive of both ends).`
      );
    }
    lines.push('');
  }
  lines.push(
    `Add or extend ONE entry at the top of ${CHANGELOG_NAME} for this whole work item — a ` +
      `'## <YYYY-MM-DD> — <short title>' heading, a short prose paragraph, then a trailer line ` +
      `'Commits: <shas or A..B> · vibecoded with <model>'. If commits haven't happened yet, write ` +
      `'Commits: (uncommitted)' for now.`
  );
  lines.push(
    `Edit the file only — do NOT run git commit or git add; the human approves every commit ` +
      `separately. See docs/fork-changelog.md for the format.`
  );

  console.log(JSON.stringify({ decision: 'block', reason: lines.join('\n') }));
  exitOpen();
}

/* ---------- dispatch (fail open on any surprise) ---------- */

function main() {
  const root = projectRoot();
  if (tryGit(['rev-parse', '--is-inside-work-tree'], root) !== 'true') exitOpen();

  const input = readStdinJson();

  if (process.env.FORK_CHANGELOG_SKIP === '1') exitOpen();
  if (fs.existsSync(path.join(root, STATE_DIR, 'DISABLED'))) exitOpen();

  if (mode === 'session-start') return sessionStart(root, input);
  if (mode === 'record-edit') return recordEdit(root, input);
  if (mode === 'stop') {
    if (input.stop_hook_active === true) exitOpen(); // already retried once this turn
    if (tryGit(['symbolic-ref', '-q', 'HEAD'], root) === null) exitOpen(); // detached HEAD
    return stop(root, input);
  }
  exitOpen();
}

try {
  main();
} catch {
  // Never let a bug in this script hang a session.
  process.exit(0);
}
