import assert from 'node:assert/strict';
import test from 'node:test';
import { listProviders, providerFor } from '../src/providers/providerRegistry';

test('catalog exposes Codex, Claude, and custom capabilities honestly', () => {
  assert.deepEqual(
    listProviders().map((provider) => provider.kind),
    ['codex', 'claude', 'custom']
  );
  assert.equal(providerFor('codex').capabilities.resume.support, 'supported');
  assert.equal(providerFor('codex').capabilities.providerArchive.support, 'supported');
  assert.equal(providerFor('claude').capabilities.fork.support, 'supported');
  assert.equal(
    providerFor('claude').capabilities.providerArchive.support,
    'unavailable'
  );
  assert.equal(providerFor('custom').capabilities.identity.support, 'unavailable');
});

test('builds direct Codex resume and fork commands', () => {
  const provider = providerFor('codex');
  assert.deepEqual(
    provider.buildResume({
      configuredCommand: 'codex',
      providerSessionId: 'session-123',
      shell: 'posix'
    }),
    { available: true, command: "codex resume 'session-123'" }
  );
  assert.deepEqual(
    provider.buildFork({
      configuredCommand: 'codex --no-alt-screen --model=gpt-codex',
      providerSessionId: 'session-123',
      shell: 'unknown'
    }),
    {
      available: true,
      command:
        'codex --no-alt-screen --model=gpt-codex fork session-123'
    }
  );
});

test('builds direct Claude resume and fork commands', () => {
  const provider = providerFor('claude');
  assert.deepEqual(
    provider.buildResume({
      configuredCommand: 'claude',
      providerSessionId: 'claude-session',
      shell: 'powershell'
    }),
    { available: true, command: "claude --resume 'claude-session'" }
  );
  assert.deepEqual(
    provider.buildFork({
      configuredCommand: 'claude',
      providerSessionId: 'claude-session',
      shell: 'cmd'
    }),
    {
      available: true,
      command: 'claude --resume ^"claude-session^" --fork-session'
    }
  );
});

test('refuses ambiguous wrappers, positional prompts, and unsafe unknown-shell IDs', () => {
  const codex = providerFor('codex');
  for (const configuredCommand of [
    'wrapper codex',
    'codex | tee log',
    'codex fix the tests',
    'codex -m gpt-codex'
  ]) {
    const result = codex.buildResume({
      configuredCommand,
      providerSessionId: 'session-123',
      shell: 'posix'
    });
    assert.equal(result.available, false, configuredCommand);
    assert.ok(result.reason);
  }
  assert.equal(
    codex.buildResume({
      configuredCommand: 'codex',
      providerSessionId: 'unsafe session id',
      shell: 'unknown'
    }).available,
    false
  );
});

test('custom provider launches but never invents continuation support', () => {
  const custom = providerFor('custom');
  assert.deepEqual(custom.buildLaunch('  my-agent --interactive  '), {
    available: true,
    command: 'my-agent --interactive'
  });
  assert.equal(
    custom.buildResume({
      configuredCommand: 'my-agent',
      providerSessionId: 'id',
      shell: 'posix'
    }).available,
    false
  );
});

