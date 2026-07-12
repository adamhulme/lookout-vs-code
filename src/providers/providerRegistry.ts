import type { AgentKind } from '../types';
import { claudeProvider } from './claudeProvider';
import { codexProvider } from './codexProvider';
import { customProvider } from './customProvider';
import type { ProviderAdapter } from './providerAdapter';

const providers: Readonly<Record<AgentKind, ProviderAdapter>> = {
  codex: codexProvider,
  claude: claudeProvider,
  custom: customProvider
};

export function providerFor(kind: AgentKind): ProviderAdapter {
  return providers[kind];
}

export function listProviders(): readonly ProviderAdapter[] {
  return Object.values(providers);
}

