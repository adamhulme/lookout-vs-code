import type { HealthReport } from './health';
import { redactForSupport, type RedactionOptions } from './redaction';

export const SUPPORT_BUNDLE_VERSION = 1 as const;

export interface SupportProductInput {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly platform: 'win32' | 'darwin' | 'linux' | 'other';
}

export interface SupportBundleInput {
  readonly generatedAt: number;
  readonly product: SupportProductInput;
  readonly health: HealthReport;
  /** Only primitive feature state is accepted; command settings are forbidden. */
  readonly features?: Readonly<Record<string, boolean | number | 'default' | 'configured' | 'disabled'>>;
  /** Optional untrusted metadata passes through the defensive recursive redactor. */
  readonly metadata?: unknown;
  readonly redaction?: RedactionOptions;
}

export interface SupportBundle {
  readonly version: typeof SUPPORT_BUNDLE_VERSION;
  readonly generatedAt: number;
  readonly product: SupportProductInput;
  readonly remoteKind: HealthReport['remoteKind'];
  readonly totals: HealthReport['totals'];
  readonly checks: readonly SupportBundleCheck[];
  readonly features?: SupportBundleInput['features'];
  readonly metadata?: unknown;
}

export interface SupportBundleCheck {
  readonly code: HealthReport['checks'][number]['code'];
  readonly status: HealthReport['checks'][number]['status'];
  readonly remediation: HealthReport['checks'][number]['remediation'];
  readonly scope?: string;
}

export function createSupportBundle(input: SupportBundleInput): SupportBundle {
  const safeMetadata = input.metadata === undefined
    ? undefined
    : redactForSupport(input.metadata, input.redaction);
  return {
    version: SUPPORT_BUNDLE_VERSION,
    generatedAt: input.generatedAt,
    product: {
      extensionVersion: safeVersion(input.product.extensionVersion),
      vscodeVersion: safeVersion(input.product.vscodeVersion),
      platform: input.product.platform
    },
    remoteKind: input.health.remoteKind,
    totals: { ...input.health.totals },
    checks: input.health.checks.map((check) => ({
      code: check.code,
      status: check.status,
      remediation: check.remediation,
      ...(check.scope ? { scope: safeScope(check.scope) } : {})
    })),
    ...(input.features ? { features: safeFeatures(input.features) } : {}),
    ...(safeMetadata !== undefined ? { metadata: safeMetadata } : {})
  };
}

export function serializeSupportBundle(bundle: SupportBundle): string {
  return `${JSON.stringify(bundle, undefined, 2)}\n`;
}

function safeFeatures(
  features: NonNullable<SupportBundleInput['features']>
): NonNullable<SupportBundle['features']> {
  return Object.fromEntries(
    Object.entries(features).filter(([key]) =>
      !/(?:command|token|secret|auth|endpoint|url|path|id)/i.test(key)
    )
  );
}

function safeVersion(value: string): string {
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,80}$/.test(value)
    ? value
    : 'unknown';
}

function safeScope(value: string): string {
  return /^[a-z0-9-]{1,40}$/i.test(value) ? value : 'session';
}
