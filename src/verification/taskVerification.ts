import { createHash } from 'node:crypto';
import type {
  VerificationCheckOutcome,
  VerificationCheckReason,
  VerificationFreshnessSignature,
  VerificationPolicy,
  VerificationRun
} from './verificationTypes';

export type VerificationTaskKind = 'test' | 'workspace-fallback';

/** Runtime-only task identity. Only its one-way digest crosses persistence. */
export interface VerificationTaskIdentity {
  readonly kind: VerificationTaskKind;
  readonly name: string;
  readonly source: string;
  readonly definitionType: string;
  readonly scope: string;
}

export interface TaskCompletion {
  readonly exitCode?: number;
  readonly launchFailed?: boolean;
}

const STEP_ID = 'vscode-task';
const POLICY_REVISION = 1;

export function taskVerificationPolicy(
  identity: VerificationTaskIdentity
): VerificationPolicy {
  const label = fixedTaskLabel(identity.kind);
  return {
    id: `lookout.vscode-task.${identity.kind}.${taskIdentityDigest(identity)}`,
    revision: POLICY_REVISION,
    label: 'VS Code Task verification',
    steps: [
      {
        id: STEP_ID,
        type: 'task',
        label,
        required: true,
        // The policy is runtime-only. Keep even this projection generic so a
        // later persistence boundary cannot accidentally retain a task name.
        task: { name: label }
      }
    ]
  };
}

export function restoredTaskVerificationPolicy(
  run: VerificationRun
): VerificationPolicy | undefined {
  if (!run.policyId.startsWith('lookout.vscode-task.')) {
    return undefined;
  }
  const check = run.checks.find((candidate) => candidate.stepId === STEP_ID);
  if (!check || check.stepType !== 'task') {
    return undefined;
  }
  return {
    id: run.policyId,
    revision: run.policyRevision,
    label: 'VS Code Task verification',
    steps: [
      {
        id: STEP_ID,
        type: 'task',
        label: check.label,
        required: true,
        task: { name: check.label }
      }
    ]
  };
}

export function startTaskVerificationRun(
  contextId: string,
  identity: VerificationTaskIdentity,
  startedAt = Date.now()
): VerificationRun {
  const policy = taskVerificationPolicy(identity);
  const digest = createHash('sha256')
    .update(contextId)
    .update('\0')
    .update(policy.id)
    .update('\0')
    .update(String(startedAt))
    .digest('hex')
    .slice(0, 16);
  return {
    id: `task-run-${startedAt.toString(36)}-${digest}`,
    contextId,
    policyId: policy.id,
    policyRevision: policy.revision,
    startedAt,
    checks: [
      {
        id: `${digest}-${STEP_ID}`,
        stepId: STEP_ID,
        stepType: 'task',
        label: fixedTaskLabel(identity.kind),
        required: true,
        outcome: 'running',
        startedAt
      }
    ]
  };
}

export function completeTaskVerificationRun(
  run: VerificationRun,
  completion: TaskCompletion,
  signature: VerificationFreshnessSignature | undefined,
  completedAt = Date.now()
): VerificationRun {
  const result = completionResult(completion);
  return {
    ...run,
    completedAt,
    ...(signature ? { signature } : {}),
    checks: run.checks.map((check) => ({
      ...check,
      outcome: result.outcome,
      completedAt,
      durationMs: Math.max(0, completedAt - (check.startedAt ?? run.startedAt)),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.reason ? { reason: result.reason } : {})
    }))
  };
}

export function taskIdentityDigest(identity: VerificationTaskIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex');
}

function completionResult(completion: TaskCompletion): {
  readonly outcome: VerificationCheckOutcome;
  readonly reason?: VerificationCheckReason;
  readonly exitCode?: number;
} {
  if (completion.launchFailed) {
    return { outcome: 'unavailable', reason: 'unavailable' };
  }
  if (completion.exitCode === undefined) {
    return { outcome: 'unknown', reason: 'unknown-exit' };
  }
  return completion.exitCode === 0
    ? { outcome: 'passed', exitCode: 0 }
    : {
        outcome: 'failed',
        reason: 'non-zero-exit',
        exitCode: completion.exitCode
      };
}

function fixedTaskLabel(kind: VerificationTaskKind): string {
  return kind === 'test'
    ? 'VS Code Test task'
    : 'Workspace task fallback';
}
