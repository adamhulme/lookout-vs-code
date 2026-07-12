import type { HealthCheck, HealthReport, HealthStatus } from './health';
import { redactForSupport } from './redaction';

export interface DoctorHeader {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly platform: 'win32' | 'darwin' | 'linux' | 'other';
}

/** Safe, line-oriented text suitable for a VS Code LogOutputChannel. */
export function formatDoctorReport(
  report: HealthReport,
  header: DoctorHeader
): readonly string[] {
  return [
    `Lookout Doctor v${safeVersion(header.extensionVersion)}`,
    `VS Code ${safeVersion(header.vscodeVersion)} · ${header.platform} · ${report.remoteKind}`,
    `Observed ${safeTimestamp(report.observedAt)}`,
    `Summary: ${statusSummary(report)}`,
    ...report.checks.map(formatCheck)
  ];
}

function formatCheck(check: HealthCheck): string {
  const scope = check.scope ? ` [${safeScope(check.scope)}]` : '';
  const remediation = check.remediation === 'none'
    ? ''
    : ` · remediation=${check.remediation}`;
  return `${statusIcon(check.status)} ${check.code}${scope}: ${safeText(check.summary)}${remediation}`;
}

function statusSummary(report: HealthReport): string {
  const order: readonly HealthStatus[] = [
    'healthy',
    'degraded',
    'unavailable',
    'blocked',
    'unknown'
  ];
  return order.map((status) => `${status}=${report.totals[status]}`).join(' · ');
}

function statusIcon(status: HealthStatus): string {
  switch (status) {
    case 'healthy': return '[ok]';
    case 'degraded': return '[warn]';
    case 'unavailable': return '[off]';
    case 'blocked': return '[blocked]';
    case 'unknown': return '[unknown]';
  }
}

function safeVersion(value: string): string {
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,80}$/.test(value)
    ? value
    : 'unknown';
}

function safeTimestamp(value: number): string {
  try {
    return new Date(value).toISOString();
  } catch {
    return 'unknown';
  }
}

function safeScope(value: string): string {
  return /^[a-z0-9-]{1,40}$/i.test(value) ? value : 'session';
}

function safeText(value: string): string {
  const redacted = redactForSupport(value);
  const text = typeof redacted === 'string'
    ? redacted
    : 'No details available.';
  return [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}
