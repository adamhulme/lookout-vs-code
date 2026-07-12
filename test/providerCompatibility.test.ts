import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const fixtureRoot = path.resolve(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'fake-cli'
);

interface FixtureEnvelope {
  readonly protocol: string;
  readonly provider: 'codex' | 'claude';
  readonly action: string;
  readonly payload: Record<string, unknown>;
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} fixture emits the complete sanitized lifecycle`, async () => {
    const events = await runFixture(provider, []);
    assert.deepEqual(
      events.map((event) => event.action),
      [
        'session-start',
        'running',
        'attention',
        'background-start',
        'command-start',
        'command-stop',
        'background-stop',
        'turn-end',
        'exit'
      ]
    );
    assert.ok(
      events.every(
        (event) =>
          event.protocol === 'lookout-provider-fixture-v1' &&
          event.provider === provider &&
          event.payload.session_id === `${provider}-fixture-session`
      )
    );
    assert.equal(events[0]?.payload.source, 'startup');
    assertFixturePrivacy(events);
  });
}

test('Codex fixture preserves resume identity and creates a distinct fork identity', async () => {
  const resumed = await runFixture('codex', ['resume', 'codex-known-session']);
  assert.equal(resumed[0]?.payload.session_id, 'codex-known-session');
  assert.equal(resumed[0]?.payload.source, 'resume');

  const forked = await runFixture('codex', ['fork', 'codex-known-session']);
  assert.equal(forked[0]?.payload.session_id, 'codex-known-session-fork');
  assert.equal(forked[0]?.payload.source, 'startup');
});

test('Claude fixture preserves resume identity and creates a distinct fork identity', async () => {
  const resumed = await runFixture('claude', [
    '--resume',
    'claude-known-session'
  ]);
  assert.equal(resumed[0]?.payload.session_id, 'claude-known-session');
  assert.equal(resumed[0]?.payload.source, 'resume');

  const forked = await runFixture('claude', [
    '--resume',
    'claude-known-session',
    '--fork-session'
  ]);
  assert.equal(forked[0]?.payload.session_id, 'claude-known-session-fork');
  assert.equal(forked[0]?.payload.source, 'startup');
});

test('fixtures expose deterministic offline help without account state', async () => {
  for (const provider of ['codex', 'claude'] as const) {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.join(fixtureRoot, `${provider}.mjs`), '--help'],
      {
        env: {
          ...process.env,
          OPENAI_API_KEY: 'SHOULD_NOT_APPEAR',
          ANTHROPIC_API_KEY: 'SHOULD_NOT_APPEAR'
        },
        windowsHide: true
      }
    );
    assert.match(stdout, new RegExp(provider, 'i'));
    assert.equal(stdout.includes('SHOULD_NOT_APPEAR'), false);
    assert.equal(stderr, '');
  }
});

async function runFixture(
  provider: 'codex' | 'claude',
  args: readonly string[]
): Promise<FixtureEnvelope[]> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(fixtureRoot, `${provider}.mjs`), ...args],
    {
      env: {
        ...process.env,
        OPENAI_API_KEY: 'SHOULD_NOT_APPEAR',
        ANTHROPIC_API_KEY: 'SHOULD_NOT_APPEAR'
      },
      windowsHide: true
    }
  );
  assert.equal(stderr, '');
  assert.equal(stdout.includes('SHOULD_NOT_APPEAR'), false);
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureEnvelope);
}

function assertFixturePrivacy(events: readonly FixtureEnvelope[]): void {
  const serialized = JSON.stringify(events);
  const keys = collectObjectKeys(events);
  for (const forbidden of [
    'transcript_path',
    'prompt',
    'last_assistant_message',
    'tool_response',
    'stdout',
    'stderr',
    'SHOULD_NOT_APPEAR'
  ]) {
    assert.equal(keys.has(forbidden), false, forbidden);
  }
  assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);
  assert.equal(serialized.includes(process.cwd()), false);
  assert.equal(serialized.includes(path.dirname(process.execPath)), false);
}

function collectObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjectKeys(item, keys);
    }
    return keys;
  }
  if (typeof value !== 'object' || value === null) {
    return keys;
  }
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectObjectKeys(nested, keys);
  }
  return keys;
}
