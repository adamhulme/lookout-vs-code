import type {
  DiagnosticBaselineIssue,
  DiagnosticBaselineMetadata,
  ReviewContext,
  VerificationCheckReason,
  VerificationCheckResult,
  VerificationFreshnessSignature,
  VerificationRun
} from './verificationTypes';

export const VERIFICATION_STORE_VERSION = 1;

export interface VerificationStoreState {
  readonly version: typeof VERIFICATION_STORE_VERSION;
  readonly contexts: readonly ReviewContext[];
  readonly runs: readonly VerificationRun[];
  readonly diagnosticBaselines: readonly DiagnosticBaselineMetadata[];
}

export interface VerificationStoreLimits {
  readonly maxContexts: number;
  readonly maxRunsPerContext: number;
  readonly maxDiagnosticBaselines: number;
  readonly maxDiagnosticHashes: number;
  readonly maxAttachedSessions: number;
  readonly retentionMs: number;
}

export const DEFAULT_VERIFICATION_STORE_LIMITS: VerificationStoreLimits = {
  maxContexts: 100,
  maxRunsPerContext: 20,
  maxDiagnosticBaselines: 100,
  maxDiagnosticHashes: 10_000,
  maxAttachedSessions: 32,
  retentionMs: 90 * 24 * 60 * 60 * 1000
};

export function emptyVerificationStore(): VerificationStoreState {
  return {
    version: VERIFICATION_STORE_VERSION,
    contexts: [],
    runs: [],
    diagnosticBaselines: []
  };
}

/**
 * Loads current or legacy-v0 data through an allow-list projection. Unknown
 * fields (including output/transcript-like data) cannot survive this boundary.
 */
export function loadVerificationStore(
  value: unknown,
  now = Date.now(),
  limits: VerificationStoreLimits = DEFAULT_VERIFICATION_STORE_LIMITS
): VerificationStoreState {
  if (!isRecord(value)) {
    return emptyVerificationStore();
  }
  const version = value.version;
  if (version !== 0 && version !== VERIFICATION_STORE_VERSION) {
    return emptyVerificationStore();
  }
  const contexts = array(value.contexts)
    .map(readContext)
    .filter((context): context is ReviewContext => context !== undefined);
  const rawRuns = version === 0 && isRecord(value.runsByContext)
    ? Object.values(value.runsByContext).flatMap(array)
    : array(value.runs);
  const runs = rawRuns
    .map(readRun)
    .filter((run): run is VerificationRun => run !== undefined);
  const diagnosticBaselines = array(value.diagnosticBaselines)
    .map(readDiagnosticBaseline)
    .filter(
      (baseline): baseline is DiagnosticBaselineMetadata =>
        baseline !== undefined
    );
  return boundVerificationStore(
    {
      version: VERIFICATION_STORE_VERSION,
      contexts,
      runs,
      diagnosticBaselines
    },
    now,
    limits
  );
}

export function boundVerificationStore(
  state: VerificationStoreState,
  now = Date.now(),
  limits: VerificationStoreLimits = DEFAULT_VERIFICATION_STORE_LIMITS
): VerificationStoreState {
  const cutoff = now - Math.max(0, limits.retentionMs);
  const contexts = [...state.contexts]
    .filter(
      (context) => context.status === 'active' || (context.closedAt ?? 0) >= cutoff
    )
    .sort(
      (left, right) =>
        Number(right.status === 'active') - Number(left.status === 'active') ||
        right.updatedAt - left.updatedAt
    )
    .slice(0, Math.max(0, limits.maxContexts))
    .map((context) => ({
      ...context,
      attachedSessionIds: context.attachedSessionIds.slice(
        0,
        Math.max(0, limits.maxAttachedSessions)
      )
    }));
  const contextIds = new Set(contexts.map((context) => context.id));
  const runs: VerificationRun[] = [];
  for (const context of contexts) {
    const retained = state.runs
      .filter(
        (run) =>
          run.contextId === context.id &&
          (run.completedAt ?? run.startedAt) >= cutoff
      )
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, Math.max(0, limits.maxRunsPerContext));
    runs.push(...retained);
  }
  const referencedBaselines = new Set(
    contexts
      .map((context) => context.diagnosticBaselineId)
      .filter((id): id is string => id !== undefined)
  );
  const diagnosticBaselines = state.diagnosticBaselines
    .filter(
      (baseline) =>
        contextIds.has(baseline.contextId) &&
        (referencedBaselines.has(baseline.id) || baseline.createdAt >= cutoff)
    )
    .sort(
      (left, right) =>
        Number(referencedBaselines.has(right.id)) -
          Number(referencedBaselines.has(left.id)) ||
        right.createdAt - left.createdAt
    )
    .slice(0, Math.max(0, limits.maxDiagnosticBaselines))
    .map((baseline) => boundDiagnosticHashes(baseline, limits.maxDiagnosticHashes));
  return {
    version: VERIFICATION_STORE_VERSION,
    contexts,
    runs,
    diagnosticBaselines
  };
}

/** Returns a JSON-safe allow-listed copy suitable for workspaceState.update. */
export function persistableVerificationStore(
  state: VerificationStoreState,
  now = Date.now(),
  limits: VerificationStoreLimits = DEFAULT_VERIFICATION_STORE_LIMITS
): VerificationStoreState {
  // Reloading our own value applies the same strict projection used for data
  // crossing a process/version boundary and drops accidental extra fields.
  return loadVerificationStore(state, now, limits);
}

function readContext(value: unknown): ReviewContext | undefined {
  if (!isRecord(value) || !isRecord(value.baseline)) {
    return undefined;
  }
  const baseline = value.baseline;
  const id = stringValue(value.id);
  const repoRoot = stringValue(value.repoRoot);
  const repoRootKey = stringValue(value.repoRootKey);
  const sessionId = stringValue(baseline.sessionId);
  const commit = stringValue(baseline.commit);
  const branch = stringValue(baseline.branch);
  const capturedAt = numberValue(baseline.capturedAt);
  const createdAt = numberValue(value.createdAt);
  const updatedAt = numberValue(value.updatedAt);
  if (
    id === undefined ||
    repoRoot === undefined ||
    repoRootKey === undefined ||
    sessionId === undefined ||
    commit === undefined ||
    branch === undefined ||
    capturedAt === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    (value.status !== 'active' && value.status !== 'closed')
  ) {
    return undefined;
  }
  const attachedSessionIds = array(value.attachedSessionIds).filter(
    (item): item is string => typeof item === 'string'
  );
  return {
    id,
    repoRoot,
    repoRootKey,
    ...(typeof value.repositoryId === 'string'
      ? { repositoryId: value.repositoryId }
      : {}),
    baseline: {
      sessionId,
      commit,
      branch,
      capturedAt
    },
    createdAt,
    updatedAt,
    status: value.status,
    attachedSessionIds,
    ...(typeof value.diagnosticBaselineId === 'string'
      ? { diagnosticBaselineId: value.diagnosticBaselineId }
      : {}),
    ...(typeof value.closedAt === 'number' ? { closedAt: value.closedAt } : {})
  };
}

function readRun(value: unknown): VerificationRun | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringValue(value.id);
  const contextId = stringValue(value.contextId);
  const policyId = stringValue(value.policyId);
  const policyRevision = numberValue(value.policyRevision);
  const startedAt = numberValue(value.startedAt);
  if (
    id === undefined ||
    contextId === undefined ||
    policyId === undefined ||
    policyRevision === undefined ||
    startedAt === undefined
  ) {
    return undefined;
  }
  const checks = array(value.checks)
    .map(readCheck)
    .filter((check): check is VerificationCheckResult => check !== undefined);
  return {
    id,
    contextId,
    policyId,
    policyRevision,
    startedAt,
    ...(typeof value.completedAt === 'number'
      ? { completedAt: value.completedAt }
      : {}),
    ...(readSignature(value.signature)
      ? { signature: readSignature(value.signature) }
      : {}),
    checks
  };
}

function readCheck(value: unknown): VerificationCheckResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringValue(value.id);
  const stepId = stringValue(value.stepId);
  const label = stringValue(value.label);
  if (
    id === undefined ||
    stepId === undefined ||
    label === undefined ||
    !isStepType(value.stepType) ||
    typeof value.required !== 'boolean' ||
    !isCheckOutcome(value.outcome)
  ) {
    return undefined;
  }
  return {
    id,
    stepId,
    stepType: value.stepType,
    label,
    required: value.required,
    outcome: value.outcome,
    ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === 'number'
      ? { completedAt: value.completedAt }
      : {}),
    ...(typeof value.durationMs === 'number'
      ? { durationMs: value.durationMs }
      : {}),
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(isCheckReason(value.reason) ? { reason: value.reason } : {})
  };
}

function readSignature(
  value: unknown
): VerificationFreshnessSignature | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const gitHead = stringValue(value.gitHead);
  const gitWorktree = stringValue(value.gitWorktree);
  if (gitHead === undefined || gitWorktree === undefined) {
    return undefined;
  }
  return {
    gitHead,
    gitWorktree,
    ...(typeof value.diagnosticBaselineId === 'string'
      ? { diagnosticBaselineId: value.diagnosticBaselineId }
      : {}),
    ...(typeof value.diagnosticGeneration === 'number'
      ? { diagnosticGeneration: value.diagnosticGeneration }
      : {})
  };
}

function readDiagnosticBaseline(
  value: unknown
): DiagnosticBaselineMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringValue(value.id);
  const contextId = stringValue(value.contextId);
  const createdAt = numberValue(value.createdAt);
  const diagnosticCount = numberValue(value.diagnosticCount);
  const state = value.state;
  if (
    id === undefined ||
    contextId === undefined ||
    createdAt === undefined ||
    diagnosticCount === undefined ||
    value.hashAlgorithm !== 'sha256' ||
    (state !== 'complete' && state !== 'partial' && state !== 'unavailable')
  ) {
    return undefined;
  }
  const rawFingerprints = array(value.fingerprints);
  const fingerprints = rawFingerprints.filter(isSha256);
  const issues = array(value.issues).filter(isDiagnosticIssue);
  const removedInvalid = fingerprints.length !== rawFingerprints.length;
  return {
    id,
    contextId,
    createdAt,
    hashAlgorithm: 'sha256',
    state:
      removedInvalid && state === 'complete' ? 'partial' : state,
    diagnosticCount: Math.max(0, diagnosticCount),
    fingerprints,
    issues: unique([
      ...issues,
      ...(removedInvalid ? ['invalid-hashes-removed' as const] : [])
    ])
  };
}

function boundDiagnosticHashes(
  baseline: DiagnosticBaselineMetadata,
  maxHashes: number
): DiagnosticBaselineMetadata {
  const fingerprints = baseline.fingerprints.slice(0, Math.max(0, maxHashes));
  const truncated = fingerprints.length < baseline.fingerprints.length;
  return {
    ...baseline,
    state: truncated && baseline.state === 'complete' ? 'partial' : baseline.state,
    fingerprints,
    issues: unique([
      ...baseline.issues,
      ...(truncated ? ['hashes-truncated' as const] : [])
    ])
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{64}$/i.test(value);
}

function isStepType(value: unknown): value is VerificationCheckResult['stepType'] {
  return ['task', 'command', 'git', 'diagnostics', 'manual'].includes(
    String(value)
  );
}

function isCheckOutcome(
  value: unknown
): value is VerificationCheckResult['outcome'] {
  return [
    'pending',
    'running',
    'passed',
    'failed',
    'cancelled',
    'unavailable',
    'unknown',
    'skipped'
  ].includes(String(value));
}

function isCheckReason(value: unknown): value is VerificationCheckReason {
  return [
    'non-zero-exit',
    'cancelled',
    'unavailable',
    'unknown-exit',
    'policy-gate-failed',
    'manual-pending',
    'dependency-failed'
  ].includes(String(value));
}

function isDiagnosticIssue(value: unknown): value is DiagnosticBaselineIssue {
  return [
    'restored-without-baseline',
    'collection-failed',
    'hashes-truncated',
    'invalid-hashes-removed'
  ].includes(String(value));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
