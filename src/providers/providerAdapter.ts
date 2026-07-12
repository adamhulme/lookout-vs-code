import * as path from 'node:path';
import { shellQuote, type LaunchShell } from '../agentCommand';
import type { AgentKind } from '../types';

export type ProviderCapability =
  | 'launch'
  | 'lifecycle'
  | 'identity'
  | 'resume'
  | 'fork'
  | 'providerArchive'
  | 'usage'
  | 'historyDiscovery';

export type CapabilitySupport = 'supported' | 'limited' | 'unavailable';

export interface ProviderCapabilityDescription {
  readonly support: CapabilitySupport;
  readonly detail: string;
}

export type ProviderCapabilities = Readonly<
  Record<ProviderCapability, ProviderCapabilityDescription>
>;

export interface ProviderCommandResult {
  readonly available: boolean;
  readonly command?: string;
  readonly reason?: string;
}

export interface ProviderContinuationRequest {
  readonly configuredCommand: string;
  readonly providerSessionId: string;
  readonly shell: LaunchShell;
}

export interface ProviderAdapter {
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly executableName?: 'codex' | 'claude';
  readonly capabilities: ProviderCapabilities;
  buildLaunch(configuredCommand: string): ProviderCommandResult;
  buildResume(request: ProviderContinuationRequest): ProviderCommandResult;
  buildFork(request: ProviderContinuationRequest): ProviderCommandResult;
}

export function launchCommand(configuredCommand: string): ProviderCommandResult {
  const command = configuredCommand.trim();
  return command
    ? { available: true, command }
    : { available: false, reason: 'The provider launch command is empty.' };
}

export function unsupported(reason: string): ProviderCommandResult {
  return { available: false, reason };
}

export function buildDirectContinuation(
  executableName: 'codex' | 'claude',
  request: ProviderContinuationRequest,
  suffix: (providerSessionToken: string) => string
): ProviderCommandResult {
  const command = request.configuredCommand.trim();
  const direct = parseConservativeDirectCommand(command, executableName);
  if (!direct.available) {
    return direct;
  }
  const providerSessionToken = operationToken(
    request.providerSessionId,
    request.shell
  );
  if (!providerSessionToken) {
    return unsupported(
      'The provider session ID cannot be quoted safely for this terminal shell.'
    );
  }
  return {
    available: true,
    command: `${command} ${suffix(providerSessionToken)}`
  };
}

function parseConservativeDirectCommand(
  command: string,
  executableName: 'codex' | 'claude'
): ProviderCommandResult {
  if (!command) {
    return unsupported('The provider launch command is empty.');
  }
  // Continuation commands are generated only for a direct executable plus
  // unambiguous flag tokens. Wrappers, pipelines, redirects, environment
  // expansion, and positional prompts are deliberately rejected.
  if (/[\n;&|<>`$]/.test(command)) {
    return unsupported(
      'Resume and fork require a direct provider command without shell operators.'
    );
  }
  const parsed = splitFirstToken(command);
  if (!parsed) {
    return unsupported('The provider launch command could not be parsed safely.');
  }
  const executable = path
    .basename(parsed.token.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (executable !== executableName) {
    return unsupported(
      `Resume and fork require a direct ${executableName} command.`
    );
  }
  if (parsed.remainder && !hasOnlySelfContainedFlags(parsed.remainder)) {
    return unsupported(
      'The configured command contains positional arguments or split flag values; use self-contained --flag=value options for resume or fork.'
    );
  }
  return { available: true, command };
}

function splitFirstToken(
  command: string
): { readonly token: string; readonly remainder: string } | undefined {
  const first = command[0];
  if (first === '"' || first === "'") {
    const closing = command.indexOf(first, 1);
    if (closing < 0) {
      return undefined;
    }
    return {
      token: command.slice(1, closing),
      remainder: command.slice(closing + 1).trim()
    };
  }
  const match = /^(\S+)(?:\s+(.*))?$/.exec(command);
  return match
    ? { token: match[1], remainder: match[2]?.trim() ?? '' }
    : undefined;
}

function hasOnlySelfContainedFlags(remainder: string): boolean {
  return remainder
    .split(/\s+/)
    .every((token) => /^--[^=\s]+(?:=[^\s]+)?$/.test(token));
}

function operationToken(value: string, shell: LaunchShell): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /[\r\n\0]/.test(trimmed)) {
    return undefined;
  }
  if (shell === 'unknown') {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)
      ? trimmed
      : undefined;
  }
  return shellQuote(trimmed, shell);
}

