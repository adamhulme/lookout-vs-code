export const TEMPLATE_VERSION = 1 as const;

export type TemplateWorktreePolicy = 'shared' | 'isolated';
export type TemplateReviewLayout = 'default' | 'review';

export type TemplateFolderPolicy =
  | { readonly kind: 'prompt' }
  | {
      readonly kind: 'workspace';
      /** Optional multi-root folder name. Omit to use the current/default root. */
      readonly workspaceFolder?: string;
    }
  | { readonly kind: 'fixed'; readonly path: string };

export interface SessionTemplateDraft {
  readonly id: string;
  readonly name: string;
  readonly labelPattern: string;
  readonly profileId: string;
  readonly folderPolicy: TemplateFolderPolicy;
  readonly worktreePolicy: TemplateWorktreePolicy;
  readonly initialTask?: string;
  readonly browserUrl?: string;
  readonly reviewLayout: TemplateReviewLayout;
  /** A named policy resolved elsewhere; never a persisted shell command. */
  readonly verificationPolicyRef?: string;
}

export interface SessionTemplate extends SessionTemplateDraft {
  readonly version: typeof TEMPLATE_VERSION;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt?: number;
}

export interface TemplateParseSuccess {
  readonly ok: true;
  readonly template: SessionTemplate;
  readonly warnings: readonly string[];
}

export interface TemplateParseFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type TemplateParseResult = TemplateParseSuccess | TemplateParseFailure;

const MAX_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 100;
const MAX_LABEL_PATTERN_LENGTH = 160;
const MAX_INITIAL_TASK_LENGTH = 4_000;
const MAX_PATH_LENGTH = 2_048;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FORBIDDEN_SECRET_FIELDS = new Set([
  'command',
  'customcommand',
  'launchcommand',
  'commandarguments',
  'arguments',
  'env',
  'environment'
]);

export function createTemplate(
  value: unknown,
  now: number
): TemplateParseResult {
  return parseTemplateRecord(value, now, now, false);
}

export function parseStoredTemplate(
  value: unknown,
  fallbackNow: number
): TemplateParseResult {
  const record = asRecord(value);
  const createdAt = finiteTimestamp(record?.createdAt) ?? fallbackNow;
  const updatedAt = finiteTimestamp(record?.updatedAt) ?? createdAt;
  return parseTemplateRecord(value, createdAt, updatedAt, true);
}

export function containsSecretBearingCommand(value: unknown): boolean {
  const record = asRecord(value);
  return record
    ? Object.keys(record).some((key) =>
        FORBIDDEN_SECRET_FIELDS.has(key.toLowerCase())
      )
    : false;
}

function parseTemplateRecord(
  value: unknown,
  createdAt: number,
  updatedAt: number,
  migrate: boolean
): TemplateParseResult {
  const record = asRecord(value);
  if (!record) {
    return { ok: false, errors: ['Template must be an object.'] };
  }
  const warnings: string[] = [];
  if (containsSecretBearingCommand(record)) {
    if (!migrate) {
      return {
        ok: false,
        errors: [
          'Templates cannot persist commands, command arguments, or environment values. Reference a configured profile instead.'
        ]
      };
    }
    warnings.push(
      'Discarded a legacy command or environment field; templates retain only a profile reference.'
    );
  }

  const errors: string[] = [];
  const id = boundedString(record.id, 'id', MAX_ID_LENGTH, errors);
  const name = boundedString(record.name, 'name', MAX_NAME_LENGTH, errors);
  const labelPattern = boundedString(
    record.labelPattern,
    'labelPattern',
    MAX_LABEL_PATTERN_LENGTH,
    errors
  );
  const profileId = boundedString(
    record.profileId,
    'profileId',
    MAX_ID_LENGTH,
    errors
  );
  if (id && !SAFE_REFERENCE.test(id)) {
    errors.push('id must contain only letters, numbers, dot, colon, underscore, or dash.');
  }
  if (profileId && !SAFE_REFERENCE.test(profileId)) {
    errors.push(
      'profileId must contain only letters, numbers, dot, colon, underscore, or dash.'
    );
  }

  const folderPolicy = parseFolderPolicy(record.folderPolicy, errors);
  const worktreePolicy = oneOf(
    record.worktreePolicy,
    ['shared', 'isolated'] as const,
    'worktreePolicy',
    errors
  );
  const reviewLayout = oneOf(
    record.reviewLayout ?? 'default',
    ['default', 'review'] as const,
    'reviewLayout',
    errors
  );
  const initialTask = optionalBoundedString(
    record.initialTask,
    'initialTask',
    MAX_INITIAL_TASK_LENGTH,
    errors
  );
  const browserUrl = optionalBrowserUrl(record.browserUrl, errors);
  const verificationPolicyRef = optionalBoundedString(
    record.verificationPolicyRef,
    'verificationPolicyRef',
    MAX_ID_LENGTH,
    errors
  );
  if (
    verificationPolicyRef &&
    !SAFE_REFERENCE.test(verificationPolicyRef)
  ) {
    errors.push('verificationPolicyRef must be a policy identifier, not a command.');
  }

  if (
    errors.length > 0 ||
    !id ||
    !name ||
    !labelPattern ||
    !profileId ||
    !folderPolicy ||
    !worktreePolicy ||
    !reviewLayout
  ) {
    return { ok: false, errors };
  }

  const lastUsedAt = finiteTimestamp(record.lastUsedAt);
  return {
    ok: true,
    warnings,
    template: {
      version: TEMPLATE_VERSION,
      id,
      name,
      labelPattern,
      profileId,
      folderPolicy,
      worktreePolicy,
      reviewLayout,
      createdAt,
      updatedAt,
      ...(initialTask ? { initialTask } : {}),
      ...(browserUrl ? { browserUrl } : {}),
      ...(verificationPolicyRef ? { verificationPolicyRef } : {}),
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {})
    }
  };
}

function parseFolderPolicy(
  value: unknown,
  errors: string[]
): TemplateFolderPolicy | undefined {
  if (value === 'prompt' || value === 'workspace') {
    return { kind: value };
  }
  const record = asRecord(value);
  if (!record) {
    errors.push('folderPolicy must be prompt, workspace, or a fixed path.');
    return undefined;
  }
  if (record.kind === 'prompt') {
    return { kind: 'prompt' };
  }
  if (record.kind === 'workspace') {
    const workspaceFolder = optionalBoundedString(
      record.workspaceFolder,
      'folderPolicy.workspaceFolder',
      MAX_NAME_LENGTH,
      errors
    );
    return {
      kind: 'workspace',
      ...(workspaceFolder ? { workspaceFolder } : {})
    };
  }
  if (record.kind === 'fixed') {
    const path = boundedString(
      record.path,
      'folderPolicy.path',
      MAX_PATH_LENGTH,
      errors
    );
    if (path && /[\r\n\0]/.test(path)) {
      errors.push('folderPolicy.path cannot contain control characters.');
    }
    return path ? { kind: 'fixed', path } : undefined;
  }
  errors.push('folderPolicy.kind is not supported.');
  return undefined;
}

function optionalBrowserUrl(
  value: unknown,
  errors: string[]
): string | undefined {
  const text = optionalBoundedString(value, 'browserUrl', 2_048, errors);
  if (!text) {
    return undefined;
  }
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push('browserUrl must use http or https.');
      return undefined;
    }
    return url.toString();
  } catch {
    errors.push('browserUrl must be a valid URL.');
    return undefined;
  }
}

function boundedString(
  value: unknown,
  field: string,
  maximum: number,
  errors: string[]
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${field} is required.`);
    return undefined;
  }
  const text = value.trim();
  if (text.length > maximum) {
    errors.push(`${field} must be at most ${maximum} characters.`);
    return undefined;
  }
  if (/[\r\n\0]/.test(text)) {
    errors.push(`${field} cannot contain control characters.`);
    return undefined;
  }
  return text;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maximum: number,
  errors: string[]
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return boundedString(value, field, maximum, errors);
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
  errors: string[]
): T | undefined {
  if (typeof value === 'string' && values.includes(value as T)) {
    return value as T;
  }
  errors.push(`${field} is not supported.`);
  return undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function asRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
