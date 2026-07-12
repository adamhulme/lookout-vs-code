import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  DiagnosticBaselineIssue,
  DiagnosticBaselineMetadata,
  DiagnosticBaselineState
} from './verificationTypes';
import type { RuntimeDiagnostic } from './runtimeEvidence';

export interface DiagnosticEvidenceOptions {
  readonly maxFingerprints?: number;
  readonly maxAddedItems?: number;
  readonly platform?: NodeJS.Platform;
}

export interface DiagnosticDeltaEvidence {
  readonly state: DiagnosticBaselineState;
  readonly baselineId: string;
  readonly generation: number;
  readonly currentCount: number;
  readonly comparedCount: number;
  readonly addedCount: number;
  readonly removedCount: number;
  readonly unchangedCount: number;
  readonly added: readonly RuntimeDiagnostic[];
  readonly addedTruncated: boolean;
  readonly issues: readonly DiagnosticBaselineIssue[];
}

const DEFAULT_MAX_FINGERPRINTS = 10_000;
const DEFAULT_MAX_ADDED_ITEMS = 100;

export function fingerprintDiagnostic(
  diagnostic: RuntimeDiagnostic,
  platform: NodeJS.Platform = process.platform
): string {
  const normalizedPath = path.normalize(diagnostic.path);
  const canonicalPath = platform === 'win32'
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  return createHash('sha256')
    .update(
      JSON.stringify([
        canonicalPath,
        diagnostic.range.startLine,
        diagnostic.range.startCharacter,
        diagnostic.range.endLine,
        diagnostic.range.endCharacter,
        diagnostic.severity,
        diagnostic.source ?? null,
        diagnostic.code ?? null,
        diagnostic.message.replace(/\r\n/g, '\n')
      ])
    )
    .digest('hex');
}

export function captureDiagnosticBaseline(
  id: string,
  contextId: string,
  diagnostics: readonly RuntimeDiagnostic[],
  createdAt = Date.now(),
  options: DiagnosticEvidenceOptions = {}
): DiagnosticBaselineMetadata {
  const max = Math.max(
    0,
    options.maxFingerprints ?? DEFAULT_MAX_FINGERPRINTS
  );
  const retained = diagnostics.slice(0, max);
  const truncated = retained.length < diagnostics.length;
  return {
    id,
    contextId,
    createdAt,
    hashAlgorithm: 'sha256',
    state: truncated ? 'partial' : 'complete',
    diagnosticCount: diagnostics.length,
    fingerprints: retained.map((diagnostic) =>
      fingerprintDiagnostic(diagnostic, options.platform)
    ),
    issues: truncated ? ['hashes-truncated'] : []
  };
}

export function unavailableDiagnosticBaseline(
  id: string,
  contextId: string,
  createdAt = Date.now(),
  issue: DiagnosticBaselineIssue = 'collection-failed'
): DiagnosticBaselineMetadata {
  return {
    id,
    contextId,
    createdAt,
    hashAlgorithm: 'sha256',
    state: 'unavailable',
    diagnosticCount: 0,
    fingerprints: [],
    issues: [issue]
  };
}

export function computeDiagnosticDelta(
  baseline: DiagnosticBaselineMetadata,
  current: readonly RuntimeDiagnostic[],
  generation: number,
  options: DiagnosticEvidenceOptions = {}
): DiagnosticDeltaEvidence {
  const maxFingerprints = Math.max(
    0,
    options.maxFingerprints ?? DEFAULT_MAX_FINGERPRINTS
  );
  const maxAddedItems = Math.max(
    0,
    options.maxAddedItems ?? DEFAULT_MAX_ADDED_ITEMS
  );
  const compared = current.slice(0, maxFingerprints);
  const currentTruncated = compared.length < current.length;
  const remainingBaseline = counts(baseline.fingerprints);
  let unchangedCount = 0;
  let addedCount = 0;
  const added: RuntimeDiagnostic[] = [];
  for (const diagnostic of compared) {
    const fingerprint = fingerprintDiagnostic(diagnostic, options.platform);
    const remaining = remainingBaseline.get(fingerprint) ?? 0;
    if (remaining > 0) {
      unchangedCount += 1;
      if (remaining === 1) {
        remainingBaseline.delete(fingerprint);
      } else {
        remainingBaseline.set(fingerprint, remaining - 1);
      }
      continue;
    }
    addedCount += 1;
    if (added.length < maxAddedItems) {
      added.push(diagnostic);
    }
  }
  const removedCount = [...remainingBaseline.values()].reduce(
    (total, count) => total + count,
    0
  );
  const issues = unique([
    ...baseline.issues,
    ...(currentTruncated ? ['hashes-truncated' as const] : [])
  ]);
  const state: DiagnosticBaselineState =
    baseline.state === 'unavailable'
      ? 'unavailable'
      : baseline.state === 'partial' || currentTruncated
        ? 'partial'
        : 'complete';
  return {
    state,
    baselineId: baseline.id,
    generation,
    currentCount: current.length,
    comparedCount: compared.length,
    addedCount,
    removedCount,
    unchangedCount,
    added,
    addedTruncated: added.length < addedCount,
    issues
  };
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
