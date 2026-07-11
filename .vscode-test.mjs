import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from '@vscode/test-cli';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceFolder = path.join(repositoryRoot, '.vscode-test', 'workspace');

rmSync(workspaceFolder, { recursive: true, force: true });
mkdirSync(path.join(workspaceFolder, '.vscode'), { recursive: true });
mkdirSync(path.join(workspaceFolder, 'src'), { recursive: true });
writeFileSync(
  path.join(workspaceFolder, '.vscode', 'settings.json'),
  JSON.stringify(
    {
      'security.workspace.trust.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'extensions.autoCheckUpdates': false,
      'lookout.terminals.location': 'panel',
      'lookout.attentionSound.enabled': false,
      'lookout.notifyOnAgentExit': false,
      'lookout.notifyOnAttention': false,
      'lookout.notifyOnTurnComplete': false,
      'lookout.usage.codex.enabled': false,
      'lookout.usage.claude.enabled': false
    },
    undefined,
    2
  )
);
writeFileSync(
  path.join(workspaceFolder, 'src', 'review-target.ts'),
  "export const value = 'baseline';\n"
);
execFileSync('git', ['init', '--quiet', workspaceFolder]);
execFileSync('git', ['-C', workspaceFolder, 'add', '.']);
execFileSync(
  'git',
  [
    '-C',
    workspaceFolder,
    '-c',
    'user.name=Lookout Tests',
    '-c',
    'user.email=lookout@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture baseline'
  ]
);

export default defineConfig({
  label: 'integration',
  files: 'out/test/integration/**/*.integration.js',
  extensionDevelopmentPath: repositoryRoot,
  workspaceFolder,
  version: process.env.LOOKOUT_VSCODE_VERSION ?? 'stable',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  env: {
    LOOKOUT_TEST: '1'
  },
  mocha: {
    timeout: 20_000
  }
});
