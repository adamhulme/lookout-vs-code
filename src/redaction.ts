export interface RedactionOptions {
  readonly homePaths?: readonly string[];
  readonly workspacePaths?: readonly string[];
}

const OMITTED = Symbol('omitted');
const FORBIDDEN_KEY_FRAGMENTS = [
  'token', 'secret', 'password', 'authorization', 'auth', 'credential',
  'endpoint', 'notifyurl', 'sessionid', 'providerid', 'latestevent',
  'message', 'command', 'arguments', 'environment', 'env', 'prompt',
  'reasoning', 'transcript', 'output', 'stdout', 'stderr'
] as const;
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,})/gi;

export function redactForSupport(
  value: unknown,
  options: RedactionOptions = {}
): unknown {
  const redacted = redactValue(value, options, new Set<object>());
  return redacted === OMITTED ? undefined : redacted;
}

function redactValue(
  value: unknown,
  options: RedactionOptions,
  seen: Set<object>
): unknown | typeof OMITTED {
  if (typeof value === 'string') {
    return redactString(value, options);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '<circular>';
    }
    seen.add(value);
    const items = value
      .map((item) => redactValue(item, options, seen))
      .filter((item) => item !== OMITTED);
    seen.delete(value);
    return items;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '<circular>';
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isForbiddenKey(key)) {
        continue;
      }
      const redacted = redactValue(item, options, seen);
      if (redacted !== OMITTED) {
        result[key] = redacted;
      }
    }
    seen.delete(value);
    return result;
  }
  return OMITTED;
}

function redactString(value: string, options: RedactionOptions): string {
  let result = value.replace(SECRET_VALUE, '<redacted-secret>');
  for (const [index, workspacePath] of (options.workspacePaths ?? []).entries()) {
    result = replacePath(result, workspacePath, `<workspace-${index + 1}>`);
  }
  for (const homePath of options.homePaths ?? []) {
    result = replacePath(result, homePath, '<home>');
  }
  result = stripUrlQuery(result);
  return result;
}

function replacePath(value: string, target: string, replacement: string): string {
  const path = target.trim().replace(/[\\/]+$/, '');
  if (!path) {
    return value;
  }
  return value.replace(new RegExp(escapeRegExp(path), 'gi'), replacement);
}

function stripUrlQuery(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return '<redacted-url>';
    }
  });
}

function isForbiddenKey(key: string): boolean {
  const compact = key.replace(/[^a-z0-9]+/gi, '').toLowerCase();
  return compact === 'id' ||
    compact.endsWith('threadid') ||
    compact.endsWith('conversationid') ||
    FORBIDDEN_KEY_FRAGMENTS.some((fragment) => compact.includes(fragment));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
