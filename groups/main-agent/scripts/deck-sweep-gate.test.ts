import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The gate is a bash script that talks to the Deck REST API over HTTP, so it
// is exercised end to end against a local fixture server rather than unit
// tested: the parts most likely to break (state-file round trip, the embedded
// node program, the last-line contract) only exist in that composition.
const GATE = join(dirname(fileURLToPath(import.meta.url)), 'deck-sweep-gate.sh');

type Card = { id: number; title: string; lastModified: number; commentsCount?: number; overdue?: number };

function card(id: number, lastModified: number, commentsCount = 0, overdue = 0): Card {
  return { id, title: `card ${id}`, lastModified, commentsCount, overdue };
}

function board(todo: Card[], doing: Card[] = []) {
  return [
    { id: 11, title: 'To do', cards: todo },
    { id: 12, title: 'Doing', cards: doing },
    { id: 13, title: 'Review', cards: [card(99, 1)] },
  ];
}

// The fixture server runs in a child process on purpose: the gate is invoked
// with execFileSync, which blocks the thread the test runs on — an in-process
// server would never get to answer the request curl makes.
let server: ChildProcess;
let base = '';
let root = '';
let dir = '';
let fixturePath = '';

function setFixture(stacks: unknown) {
  writeFileSync(fixturePath, JSON.stringify(stacks));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'deck-gate-root-'));
  fixturePath = join(root, 'fixture.json');
  setFixture(board([]));
  server = spawn(
    process.execPath,
    [
      '-e',
      `const { readFileSync } = require("node:fs");
       const s = require("node:http").createServer((_q, r) => {
         r.setHeader("content-type", "application/json");
         r.end(readFileSync(process.env.FIXTURE, "utf8"));
       });
       s.listen(0, "127.0.0.1", () => console.log(s.address().port));`,
    ],
    { env: { ...process.env, FIXTURE: fixturePath }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise<string>((resolve, reject) => {
    server.stdout?.once('data', (d: Buffer) => {
      // FORCE_COLOR in the caller's environment colours even a bare
      // console.log(number) in this child — strip any ANSI, or curl gets a
      // URL with escape sequences in it and every test fails with
      // "bad range in URL position".
      resolve(d.toString().replace(/\x1b\[[0-9;]*m/g, '').trim());
    });
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.kill();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-gate-'));
});

type Decision = {
  wakeAgent: boolean;
  data?: {
    watchedStacks?: string[];
    changed?: { id: number; title: string; stack: string }[];
    unchanged?: number;
    fullSweep?: boolean;
    cards?: { id: number; title: string; stack: string }[];
  };
};

function runGate(forceFullEvery?: number): Decision {
  const config = join(dir, 'gate.env');
  writeFileSync(
    config,
    [
      `NC_HOST=${base}`,
      'NC_USER=tester',
      'BOARD_ID=1',
      'WATCHED_STACKS="11 12"',
      forceFullEvery === undefined ? '' : `FORCE_FULL_EVERY=${forceFullEvery}`,
      '',
    ].join('\n'),
  );
  const out = execFileSync('bash', [GATE], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DECK_GATE_CONFIG: config,
      DECK_GATE_STATE: join(dir, 'gate.state'),
      // This host's shell can carry an HTTP_PROXY (the OneCLI gateway); a
      // curl to the loopback fixture must never go through it, or every run
      // dies with "Empty reply from server".
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
  });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('deck-sweep-gate', () => {
  it('wakes on the first run and stays quiet while nothing moves', () => {
    setFixture(board([card(1, 100)], [card(2, 200)]));
    const first = runGate(0);
    expect(first.wakeAgent).toBe(true);
    expect(first.data?.changed?.map((c) => c.id)).toEqual([1, 2]);
    expect(runGate(0).wakeAgent).toBe(false);
  });

  it('reports only the moved card as changed', () => {
    setFixture(board([card(1, 100)], [card(2, 200)]));
    runGate(0);
    setFixture(board([card(1, 100)], [card(2, 200, 1)]));
    const second = runGate(0);
    expect(second.wakeAgent).toBe(true);
    expect(second.data?.changed?.map((c) => c.id)).toEqual([2]);
    expect(second.data?.unchanged).toBe(1);
    expect(second.data?.fullSweep).toBeFalsy();
  });

  it('ignores stacks outside the watched set', () => {
    setFixture(board([card(1, 100)]));
    runGate(0);
    setFixture([
      { id: 11, title: 'To do', cards: [card(1, 100)] },
      { id: 12, title: 'Doing', cards: [] },
      { id: 13, title: 'Review', cards: [card(99, 999, 5)] },
    ]);
    expect(runGate(0).wakeAgent).toBe(false);
  });

  // The gap this covers: a card can carry an unexecuted next step without ever
  // changing again, so a pure delta gate delivers it exactly once and then
  // goes silent forever.
  it('forces a full sweep every N ticks even when nothing changed', () => {
    setFixture(board([card(1, 100)], [card(2, 200)]));
    expect(runGate(3).wakeAgent).toBe(true); // tick 1: first run
    expect(runGate(3).wakeAgent).toBe(false); // tick 2
    const forced = runGate(3); // tick 3
    expect(forced.wakeAgent).toBe(true);
    expect(forced.data?.fullSweep).toBe(true);
    expect(forced.data?.cards?.map((c) => c.id)).toEqual([1, 2]);
    expect(forced.data?.changed).toEqual([]);
    expect(runGate(3).wakeAgent).toBe(false); // counter reset, tick 1 again
    expect(runGate(3).wakeAgent).toBe(false);
    expect(runGate(3).data?.fullSweep).toBe(true);
  });

  it('counts a delta wake as a normal tick, so the full sweep still arrives', () => {
    setFixture(board([card(1, 100)]));
    runGate(3); // tick 1
    setFixture(board([card(1, 101)]));
    const delta = runGate(3); // tick 2 — real change, not a full sweep
    expect(delta.wakeAgent).toBe(true);
    expect(delta.data?.fullSweep).toBeFalsy();
    expect(runGate(3).data?.fullSweep).toBe(true); // tick 3 arrives on schedule
  });

  it('never forces a wake on an empty board', () => {
    setFixture(board([]));
    expect(runGate(2).wakeAgent).toBe(false);
    expect(runGate(2).wakeAgent).toBe(false);
    expect(runGate(2).wakeAgent).toBe(false);
  });

  it('treats FORCE_FULL_EVERY=0 as disabled', () => {
    setFixture(board([card(1, 100)]));
    runGate(0);
    for (let i = 0; i < 5; i += 1) expect(runGate(0).wakeAgent).toBe(false);
  });

  it('reads a pre-existing single-line state file written by the old gate', () => {
    setFixture(board([card(1, 100)], [card(2, 200)]));
    writeFileSync(join(dir, 'gate.state'), '1:100:0:0|2:200:0:0');
    expect(runGate(0).wakeAgent).toBe(false);
  });
});
