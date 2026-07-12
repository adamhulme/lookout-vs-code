import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workflow = readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
  'utf8'
);

test('release workflow packages once and promotes the artifact by ID', () => {
  assert.equal((workflow.match(/run: npm run vsix\s*$/gm) ?? []).length, 1);
  assert.doesNotMatch(workflow, /npm run verify:vsix/);
  assert.match(workflow, /artifact-ids:.*needs\.build-artifact\.outputs\.artifact-id/);
  assert.equal((workflow.match(/release-artifact\.mjs verify/g) ?? []).length, 2);
  assert.match(workflow, /compression-level: 0/);
});

test('registry publication is manual, explicit, and environment gated', () => {
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && inputs\.publish_marketplace/
  );
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && inputs\.publish_open_vsx/
  );
  assert.match(workflow, /name: visual-studio-marketplace/);
  assert.match(workflow, /name: open-vsx/);
  assert.match(workflow, /client-id:.*vars\.AZURE_CLIENT_ID/);
  assert.match(workflow, /tenant-id:.*vars\.AZURE_TENANT_ID/);
  assert.match(workflow, /OVSX_PAT:.*secrets\.OVSX_PAT/);
  assert.doesNotMatch(workflow, /VSCE_PAT/);
});

test('publisher clients receive a verified package path and cannot package implicitly', () => {
  assert.match(
    workflow,
    /vsce publish[\s\S]*--azure-credential[\s\S]*--packagePath.*steps\.verify\.outputs\.vsix_path/
  );
  assert.match(
    workflow,
    /ovsx@1\.0\.2 publish.*steps\.verify\.outputs\.vsix_path/
  );
});
