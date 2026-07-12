import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTemplateLaunchRequest,
  createTemplate,
  migrateTemplateStore,
  retainTemplates,
  upsertTemplate,
  type SessionTemplate
} from '../src/templates';

function validTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'review-api',
    name: 'Review API',
    labelPattern: '{profile} · {folder} · {counter}',
    profileId: 'builtin.codex',
    folderPolicy: { kind: 'workspace', workspaceFolder: 'api' },
    worktreePolicy: 'isolated',
    initialTask: 'Implement the reviewed plan.',
    browserUrl: 'http://localhost:3000',
    reviewLayout: 'review',
    verificationPolicyRef: 'policy.release',
    ...overrides
  };
}

test('creates a bounded versioned template without a launch command', () => {
  const result = createTemplate(validTemplate(), 100);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.template.version, 1);
  assert.equal(result.template.createdAt, 100);
  assert.equal('command' in result.template, false);
  assert.equal(result.template.browserUrl, 'http://localhost:3000/');
});

test('refuses to persist raw command or environment fields', () => {
  const result = createTemplate(
    validTemplate({ command: 'agent --token=secret', env: { TOKEN: 'secret' } }),
    100
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join(' '), /cannot persist commands/i);
  }
});

test('store boundaries allow-list fields even from structurally unsafe callers', () => {
  const parsed = createTemplate(validTemplate(), 100);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  const unsafe = {
    ...parsed.template,
    command: 'codex --token=secret',
    environment: { TOKEN: 'secret' }
  } as SessionTemplate;
  const stored = upsertTemplate(
    { version: 1, templates: [] },
    unsafe,
    110
  );
  assert.equal(JSON.stringify(stored).includes('secret'), false);
  assert.equal('command' in stored.templates[0], false);
});

test('migrates legacy records, discards commands, deduplicates, and retains newest', () => {
  const migrated = migrateTemplateStore(
    {
      version: 0,
      templates: [
        validTemplate({ command: 'codex --secret=x', updatedAt: 10 }),
        validTemplate({ name: 'New name', updatedAt: 20 }),
        validTemplate({ id: 'second', updatedAt: 30 })
      ]
    },
    40,
    { maxTemplates: 2 }
  );
  assert.deepEqual(migrated.store.templates.map((template) => template.id), [
    'second',
    'review-api'
  ]);
  assert.equal(migrated.store.templates[1].name, 'New name');
  assert.equal(JSON.stringify(migrated.store).includes('--secret'), false);
  assert.ok(migrated.warnings.some((warning) => /Discarded a legacy command/.test(warning)));
});

test('applies age retention from last use or update', () => {
  const parsed = createTemplate(validTemplate(), 10);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(
    retainTemplates(
      { version: 1, templates: [parsed.template] },
      100,
      { maxTemplates: 10, maxUnusedAgeMs: 50 }
    ).templates.length,
    0
  );
});

test('builds a transient launch request and resolves multi-root folder policy', () => {
  const parsed = createTemplate(validTemplate(), 10);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  const result = buildTemplateLaunchRequest(parsed.template as SessionTemplate, {
    profile: {
      id: 'builtin.codex',
      kind: 'codex',
      command: 'codex --model=gpt-5',
      displayName: 'Codex'
    },
    workspaceFolders: [
      { name: 'web', path: '/repo/web' },
      { name: 'api', path: '/repo/api' }
    ],
    counter: 2
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.request.session, {
    kind: 'codex',
    label: 'Codex · api · 2',
    command: 'codex --model=gpt-5',
    cwd: '/repo/api'
  });
  assert.equal(result.request.worktreePolicy, 'isolated');
  assert.equal(result.request.verificationPolicyRef, 'policy.release');
});

test('requires runtime folder selection and matching profile', () => {
  const parsed = createTemplate(
    validTemplate({ folderPolicy: { kind: 'prompt' } }),
    10
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  const result = buildTemplateLaunchRequest(parsed.template, {
    profile: {
      id: 'builtin.claude',
      kind: 'claude',
      command: 'claude',
      displayName: 'Claude Code'
    },
    workspaceFolders: []
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join(' '), /does not match/);
    assert.match(result.errors.join(' '), /selected working folder/);
  }
});
