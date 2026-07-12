import { collectGitEvidence } from './gitEvidence';
import {
  captureDiagnosticBaseline,
  computeDiagnosticDelta,
  unavailableDiagnosticBaseline,
  type DiagnosticEvidenceOptions
} from './diagnosticEvidence';
import {
  createReviewContext,
  normalizeRepoRoot,
  reconcileReviewContext
} from './verificationModel';
import {
  buildReviewPacket,
  fingerprintGitEvidence,
  type ReviewPacket
} from './reviewPacket';
import type {
  DiagnosticEvidenceSource,
  GitEvidenceCollector,
  ReviewSessionSnapshot,
  VerificationManagerSnapshot,
  WorktreeEvidenceFingerprinter
} from './runtimeEvidence';
import type {
  DiagnosticBaselineMetadata,
  ReviewContext,
  ReviewContextAttachment,
  VerificationPolicy,
  VerificationRun
} from './verificationTypes';

export interface VerificationManagerOptions {
  readonly diagnostics?: DiagnosticEvidenceSource;
  readonly collectGit?: GitEvidenceCollector;
  readonly fingerprintWorktree?: WorktreeEvidenceFingerprinter;
  readonly diagnosticOptions?: DiagnosticEvidenceOptions;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
  readonly initial?: Partial<VerificationManagerSnapshot>;
}

export interface ReviewPacketRequest {
  readonly policy?: VerificationPolicy;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

interface CachedPacket {
  readonly packet: ReviewPacket;
  readonly expiresAt: number;
}

interface InFlightPacket {
  readonly controller: AbortController;
  readonly promise: Promise<ReviewPacket>;
}

export class ReviewEvidenceAbortError extends Error {
  public constructor() {
    super('Review evidence collection was aborted');
    this.name = 'AbortError';
  }
}

export class VerificationManager {
  private readonly contexts = new Map<string, ReviewContext>();
  private readonly activeContextIdsByRoot = new Map<string, string>();
  private readonly baselines = new Map<string, DiagnosticBaselineMetadata>();
  private readonly runs: VerificationRun[] = [];
  private readonly cache = new Map<string, CachedPacket>();
  private readonly inFlight = new Map<string, InFlightPacket>();
  private readonly diagnostics: DiagnosticEvidenceSource | undefined;
  private readonly collectGit: GitEvidenceCollector;
  private readonly fingerprintWorktree: WorktreeEvidenceFingerprinter;
  private readonly diagnosticOptions: DiagnosticEvidenceOptions;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;

  public constructor(options: VerificationManagerOptions = {}) {
    this.diagnostics = options.diagnostics;
    this.collectGit = options.collectGit ?? collectGitEvidence;
    this.fingerprintWorktree =
      options.fingerprintWorktree ??
      (async (_context, git): Promise<string> => fingerprintGitEvidence(git));
    this.diagnosticOptions = options.diagnosticOptions ?? {};
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 3_000);
    this.now = options.now ?? Date.now;
    for (const context of options.initial?.contexts ?? []) {
      this.contexts.set(context.id, context);
      if (context.status === 'active') {
        this.activeContextIdsByRoot.set(context.repoRootKey, context.id);
      }
    }
    for (const baseline of options.initial?.diagnosticBaselines ?? []) {
      this.baselines.set(baseline.id, baseline);
    }
    this.runs.push(...(options.initial?.runs ?? []));
  }

  public listContexts(): readonly ReviewContext[] {
    return [...this.contexts.values()].sort(
      (left, right) => left.createdAt - right.createdAt
    );
  }

  public getContext(id: string): ReviewContext | undefined {
    return this.contexts.get(id);
  }

  public reconcileSessions(
    sessions: readonly ReviewSessionSnapshot[]
  ): readonly ReviewContext[] {
    const grouped = new Map<string, ReviewContextAttachment[]>();
    for (const session of sessions) {
      if (!session.isOpen || !session.baseline) {
        continue;
      }
      const key = normalizeRepoRoot(session.baseline.repoRoot);
      const attachments = grouped.get(key) ?? [];
      attachments.push({
        sessionId: session.id,
        repoRoot: session.baseline.repoRoot,
        ...(session.repositoryId ? { repositoryId: session.repositoryId } : {}),
        baseline: {
          commit: session.baseline.commit,
          branch: session.baseline.branch,
          capturedAt: session.baseline.capturedAt
        }
      });
      grouped.set(key, attachments);
    }
    for (const [rootKey, contextId] of [...this.activeContextIdsByRoot]) {
      if (grouped.has(rootKey)) {
        continue;
      }
      const existing = this.contexts.get(contextId);
      const closed = reconcileReviewContext(existing, [], this.now());
      if (closed) {
        this.contexts.set(closed.id, closed);
      }
      this.activeContextIdsByRoot.delete(rootKey);
      this.invalidateContext(contextId);
    }
    for (const [rootKey, attachments] of grouped) {
      const existingId = this.activeContextIdsByRoot.get(rootKey);
      const existing = existingId ? this.contexts.get(existingId) : undefined;
      let context = existing
        ? reconcileReviewContext(existing, attachments, this.now())
        : createReviewContext(attachments, this.now());
      if (!context) {
        continue;
      }
      if (!existing && this.contexts.has(context.id)) {
        context = this.withUniqueId(context);
      }
      if (!existing) {
        context = this.attachDiagnosticBaseline(context);
      }
      this.contexts.set(context.id, context);
      this.activeContextIdsByRoot.set(rootKey, context.id);
      this.invalidateContext(context.id);
    }
    return this.listContexts();
  }

  public recordRun(run: VerificationRun): void {
    const existing = this.runs.findIndex((candidate) => candidate.id === run.id);
    if (existing >= 0) {
      this.runs.splice(existing, 1);
    }
    this.runs.push(run);
    this.invalidateContext(run.contextId);
  }

  public latestRun(contextId: string): VerificationRun | undefined {
    return this.runs
      .filter((run) => run.contextId === contextId)
      .sort((left, right) => right.startedAt - left.startedAt)[0];
  }

  public snapshot(): VerificationManagerSnapshot {
    return {
      contexts: this.listContexts(),
      runs: [...this.runs],
      diagnosticBaselines: [...this.baselines.values()]
    };
  }

  public async getReviewPacket(
    contextId: string,
    request: ReviewPacketRequest = {}
  ): Promise<ReviewPacket> {
    const key = packetKey(contextId, request.policy);
    if (request.force) {
      this.invalidateContext(contextId);
    } else {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt >= this.now()) {
        return waitForCaller(cached.packet, request.signal);
      }
      const active = this.inFlight.get(key);
      if (active) {
        return waitForPromise(active.promise, request.signal);
      }
    }
    const context = this.contexts.get(contextId);
    if (!context) {
      throw new Error(`Unknown review context: ${contextId}`);
    }
    const controller = new AbortController();
    const promise = this.collectPacket(context, request.policy, controller.signal)
      .then((packet) => {
        this.cache.set(key, {
          packet,
          expiresAt: this.now() + this.cacheTtlMs
        });
        return packet;
      })
      .finally(() => {
        if (this.inFlight.get(key)?.controller === controller) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, { controller, promise });
    return waitForPromise(promise, request.signal);
  }

  public invalidateRoot(repoRoot: string): void {
    const contextId = this.activeContextIdsByRoot.get(normalizeRepoRoot(repoRoot));
    if (contextId) {
      this.invalidateContext(contextId);
    }
  }

  public invalidateContext(contextId: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${contextId}\0`)) {
        this.cache.delete(key);
      }
    }
    for (const [key, active] of [...this.inFlight]) {
      if (key.startsWith(`${contextId}\0`)) {
        active.controller.abort();
        this.inFlight.delete(key);
      }
    }
  }

  public dispose(): void {
    for (const active of this.inFlight.values()) {
      active.controller.abort();
    }
    this.inFlight.clear();
    this.cache.clear();
  }

  private async collectPacket(
    context: ReviewContext,
    policy: VerificationPolicy | undefined,
    signal: AbortSignal
  ): Promise<ReviewPacket> {
    const baseline = {
      repoRoot: context.repoRoot,
      commit: context.baseline.commit,
      branch: context.baseline.branch,
      capturedAt: context.baseline.capturedAt
    };
    const git = await this.collectGit(baseline, { signal });
    const fingerprint = await this.fingerprintWorktree(context, git, signal);
    if (signal.aborted) {
      throw new ReviewEvidenceAbortError();
    }
    const diagnosticBaseline = context.diagnosticBaselineId
      ? this.baselines.get(context.diagnosticBaselineId)
      : undefined;
    const effectiveBaseline =
      diagnosticBaseline ??
      unavailableDiagnosticBaseline(
        `diagnostics-unavailable-${context.id}`,
        context.id,
        this.now(),
        'restored-without-baseline'
      );
    const currentDiagnostics = this.readCurrentDiagnostics(context.repoRoot);
    const comparisonBaseline = currentDiagnostics.available
      ? effectiveBaseline
      : unavailableDiagnosticBaseline(
          `diagnostics-current-unavailable-${context.id}`,
          context.id,
          this.now()
        );
    const diagnostics = computeDiagnosticDelta(
      comparisonBaseline,
      currentDiagnostics.values,
      currentDiagnostics.generation,
      this.diagnosticOptions
    );
    return buildReviewPacket({
      context,
      git,
      diagnostics,
      gitWorktreeFingerprint: fingerprint,
      policy,
      latestRun: this.latestRun(context.id),
      now: this.now()
    });
  }

  private attachDiagnosticBaseline(context: ReviewContext): ReviewContext {
    const id = `diagnostics-${context.id}`;
    let baseline: DiagnosticBaselineMetadata;
    try {
      if (!this.diagnostics) {
        throw new Error('No diagnostic source');
      }
      baseline = captureDiagnosticBaseline(
        id,
        context.id,
        this.diagnostics.snapshot(context.repoRoot),
        this.now(),
        this.diagnosticOptions
      );
    } catch {
      baseline = unavailableDiagnosticBaseline(id, context.id, this.now());
    }
    this.baselines.set(id, baseline);
    return { ...context, diagnosticBaselineId: id };
  }

  private readCurrentDiagnostics(repoRoot: string): {
    readonly values: readonly import('./runtimeEvidence').RuntimeDiagnostic[];
    readonly generation: number;
    readonly available: boolean;
  } {
    if (!this.diagnostics) {
      return { values: [], generation: 0, available: false };
    }
    try {
      return {
        values: this.diagnostics.snapshot(repoRoot),
        generation: this.diagnostics.generation(repoRoot),
        available: true
      };
    } catch {
      return { values: [], generation: 0, available: false };
    }
  }

  private withUniqueId(context: ReviewContext): ReviewContext {
    let suffix = 2;
    let id = `${context.id}-${suffix}`;
    while (this.contexts.has(id)) {
      suffix += 1;
      id = `${context.id}-${suffix}`;
    }
    return {
      ...context,
      id,
      diagnosticBaselineId: undefined
    };
  }
}

function packetKey(
  contextId: string,
  policy: VerificationPolicy | undefined
): string {
  return `${contextId}\0${policy?.id ?? 'no-policy'}@${policy?.revision ?? 0}`;
}

function waitForCaller<T>(value: T, signal: AbortSignal | undefined): Promise<T> {
  return signal?.aborted
    ? Promise.reject(new ReviewEvidenceAbortError())
    : Promise.resolve(value);
}

function waitForPromise<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new ReviewEvidenceAbortError());
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new ReviewEvidenceAbortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}
