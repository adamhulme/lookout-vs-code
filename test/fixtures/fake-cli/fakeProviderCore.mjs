/* global process */

const PROTOCOL = 'lookout-provider-fixture-v1';

export function runFakeProvider(provider, argv) {
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write(`${provider}-fixture-cli 1.0.0\n`);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(helpText(provider));
    return;
  }

  const invocation = parseInvocation(provider, argv);
  for (const event of fixtureSequence(provider, invocation)) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

function parseInvocation(provider, argv) {
  const defaultId = `${provider}-fixture-session`;
  if (provider === 'codex') {
    if (argv[0] === 'resume') {
      return { sessionId: safeId(argv[1], defaultId), source: 'resume' };
    }
    if (argv[0] === 'fork') {
      const original = safeId(argv[1], defaultId);
      return { sessionId: `${original}-fork`, source: 'startup' };
    }
  } else {
    const resumeIndex = argv.indexOf('--resume');
    if (resumeIndex >= 0) {
      const original = safeId(argv[resumeIndex + 1], defaultId);
      return argv.includes('--fork-session')
        ? { sessionId: `${original}-fork`, source: 'startup' }
        : { sessionId: original, source: 'resume' };
    }
  }
  const explicitIndex = argv.indexOf('--session-id');
  return {
    sessionId: safeId(
      explicitIndex >= 0 ? argv[explicitIndex + 1] : undefined,
      defaultId
    ),
    source: 'startup'
  };
}

function fixtureSequence(provider, invocation) {
  const common = (hookEventName, extra = {}) => ({
    session_id: invocation.sessionId,
    cwd: '<WORKSPACE>',
    hook_event_name: hookEventName,
    ...extra
  });
  const attention =
    provider === 'codex'
      ? common('PermissionRequest', { permission_mode: 'default' })
      : common('Notification', { notification_type: 'permission_prompt' });
  return [
    envelope(
      provider,
      'session-start',
      common('SessionStart', {
        source: invocation.source,
        model: '<FIXTURE_MODEL>'
      })
    ),
    envelope(provider, 'running', common('UserPromptSubmit')),
    envelope(provider, 'attention', attention),
    envelope(
      provider,
      'background-start',
      common('SubagentStart', {
        agent_id: 'fixture-agent-1',
        agent_type: 'Explore'
      })
    ),
    envelope(
      provider,
      'command-start',
      common('PreToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'fixture-command-1',
        tool_input: { command: 'npm test' }
      })
    ),
    envelope(
      provider,
      'command-stop',
      common('PostToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'fixture-command-1',
        tool_input: { command: 'npm test' },
        duration_ms: 25,
        exit_code: 0
      })
    ),
    envelope(
      provider,
      'background-stop',
      common('SubagentStop', {
        agent_id: 'fixture-agent-1',
        agent_type: 'Explore'
      })
    ),
    envelope(provider, 'turn-end', common('Stop')),
    envelope(provider, 'exit', common('SessionEnd', { reason: 'other' }))
  ];
}

function envelope(provider, action, payload) {
  return { protocol: PROTOCOL, provider, action, payload };
}

function safeId(candidate, fallback) {
  return typeof candidate === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(candidate)
    ? candidate
    : fallback;
}

function helpText(provider) {
  return provider === 'codex'
    ? [
        'Fake Codex compatibility fixture',
        'Usage: codex.mjs [resume SESSION_ID | fork SESSION_ID]',
        'Options: --session-id ID --help --version',
        ''
      ].join('\n')
    : [
        'Fake Claude compatibility fixture',
        'Usage: claude.mjs [--resume SESSION_ID] [--fork-session]',
        'Options: --session-id ID --help --version',
        ''
      ].join('\n');
}
