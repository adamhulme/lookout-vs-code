import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHealth } from '../src/health';
import { redactForSupport } from '../src/redaction';
import { createSupportBundle, serializeSupportBundle } from '../src/supportBundle';

const HOME = 'C:\\Users\\CanaryPerson';
const WORKSPACE = 'C:\\code\\canary-workspace';

test('recursive redaction removes sensitive fields, paths, IDs, and URL queries', () => {
  const redacted = redactForSupport(
    {
      safe: `opened ${WORKSPACE} from ${HOME}`,
      id: 'CANARY_BARE_PROVIDER_ID',
      providerSessionId: 'CANARY_PROVIDER_ID',
      latestEvent: 'CANARY_LATEST_EVENT',
      configuredCommand: 'codex --token CANARY_COMMAND_SECRET',
      notifyEndpoint: 'http://127.0.0.1:1234/?token=CANARY_ENDPOINT',
      env: { API_KEY: 'CANARY_ENV_SECRET' },
      auth: { bearer: 'CANARY_AUTH_SECRET' },
      transcript: 'CANARY_TRANSCRIPT',
      stdout: 'CANARY_OUTPUT',
      nested: {
        link: 'https://example.invalid/path?access_token=CANARY_QUERY#fragment',
        note: 'Bearer CANARY_BEARER_1234567890'
      }
    },
    { homePaths: [HOME], workspacePaths: [WORKSPACE] }
  );
  const serialized = JSON.stringify(redacted);
  for (const canary of [
    'CANARY_PROVIDER_ID',
    'CANARY_BARE_PROVIDER_ID',
    'CANARY_LATEST_EVENT',
    'CANARY_COMMAND_SECRET',
    'CANARY_ENDPOINT',
    'CANARY_ENV_SECRET',
    'CANARY_AUTH_SECRET',
    'CANARY_TRANSCRIPT',
    'CANARY_OUTPUT',
    'CANARY_QUERY',
    'CANARY_BEARER_1234567890',
    HOME,
    WORKSPACE
  ]) {
    assert.equal(serialized.includes(canary), false, `leaked ${canary}`);
  }
  assert.match(serialized, /<workspace-1>/);
  assert.match(serialized, /<home>/);
  assert.match(serialized, /https:\/\/example\.invalid\/path/);
});

test('support bundle is versioned, allow-listed, and omits free health messages', () => {
  const health = evaluateHealth({
    observedAt: 1,
    workspaceTrusted: true,
    remoteKind: 'wsl',
    git: 'available',
    node: 'available',
    profiles: [{ kind: 'codex', state: 'available' }],
    sessions: [],
    usage: [{ provider: 'codex', state: 'current' }]
  });
  const maliciousHealth = {
    ...health,
    checks: health.checks.map((check) => ({
      ...check,
      summary: 'CANARY_HEALTH_MESSAGE',
      scope: 'provider-session-CANARY_ID'
    }))
  };
  const bundle = createSupportBundle({
    generatedAt: 2,
    product: {
      extensionVersion: '0.1.0',
      vscodeVersion: '1.100.0',
      platform: 'linux'
    },
    health: maliciousHealth,
    features: {
      lifecycleEnabled: true,
      configuredCommand: 'configured',
      endpointUrl: 'configured'
    },
    metadata: {
      workspacePath: WORKSPACE,
      session_id: 'CANARY_SESSION_ID',
      url: 'https://example.invalid/?token=CANARY_QUERY'
    },
    redaction: { workspacePaths: [WORKSPACE] }
  });
  const serialized = serializeSupportBundle(bundle);
  assert.equal(bundle.version, 1);
  assert.equal(serialized.includes('CANARY_HEALTH_MESSAGE'), false);
  assert.equal(serialized.includes('CANARY_ID'), false);
  assert.equal(serialized.includes('configuredCommand'), false);
  assert.equal(serialized.includes('endpointUrl'), false);
  assert.equal(serialized.includes('CANARY_SESSION_ID'), false);
  assert.equal(serialized.includes('CANARY_QUERY'), false);
  assert.equal(serialized.includes(WORKSPACE), false);
  assert.equal(bundle.features?.lifecycleEnabled, true);
});
