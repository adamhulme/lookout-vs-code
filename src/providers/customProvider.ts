import {
  launchCommand,
  unsupported,
  type ProviderAdapter,
  type ProviderCapabilities
} from './providerAdapter';

const capabilities: ProviderCapabilities = {
  launch: {
    support: 'supported',
    detail: 'Launches the configured command in a native terminal.'
  },
  lifecycle: {
    support: 'limited',
    detail: 'Generic agents can use the explicit Lookout attention helper.'
  },
  identity: {
    support: 'unavailable',
    detail: 'No provider-owned session identity is available.'
  },
  resume: {
    support: 'unavailable',
    detail: 'The generic provider has no safe resume contract.'
  },
  fork: {
    support: 'unavailable',
    detail: 'The generic provider has no safe fork contract.'
  },
  providerArchive: {
    support: 'unavailable',
    detail: 'The generic provider has no provider archive contract.'
  },
  usage: {
    support: 'unavailable',
    detail: 'No structured provider usage source is available.'
  },
  historyDiscovery: {
    support: 'unavailable',
    detail: 'Lookout does not inspect generic agent state.'
  }
};

export const customProvider: ProviderAdapter = {
  kind: 'custom',
  displayName: 'Custom terminal agent',
  capabilities,
  buildLaunch: launchCommand,
  buildResume: () => unsupported(capabilities.resume.detail),
  buildFork: () => unsupported(capabilities.fork.detail)
};

