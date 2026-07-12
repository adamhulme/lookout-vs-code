import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeRepoRoot } from './verificationModel';
import type {
  DiagnosticEvidenceSource,
  RuntimeDiagnostic
} from './runtimeEvidence';

/**
 * Runtime-only projection of VS Code diagnostics. The manager persists only
 * one-way fingerprints produced from these values, never paths or messages.
 */
export class VscodeDiagnosticEvidenceSource
  implements DiagnosticEvidenceSource
{
  private readonly roots = new Map<string, string>();
  private readonly generations = new Map<string, number>();

  public snapshot(repoRoot: string): readonly RuntimeDiagnostic[] {
    const key = this.registerRoot(repoRoot);
    const root = this.roots.get(key)!;
    return vscode.languages
      .getDiagnostics()
      .flatMap(([uri, diagnostics]) =>
        uri.scheme === 'file' && isWithin(root, uri.fsPath)
          ? diagnostics.map((diagnostic) => runtimeDiagnostic(uri, diagnostic))
          : []
      );
  }

  public generation(repoRoot: string): number {
    const key = this.registerRoot(repoRoot);
    return this.generations.get(key) ?? 0;
  }

  /** Advances only roots touched by the diagnostic event. */
  public noteChanges(uris: readonly vscode.Uri[]): readonly string[] {
    const changedRoots: string[] = [];
    for (const [key, root] of this.roots) {
      if (
        uris.length === 0 ||
        uris.some((uri) => uri.scheme === 'file' && isWithin(root, uri.fsPath))
      ) {
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
        changedRoots.push(root);
      }
    }
    return changedRoots;
  }

  private registerRoot(repoRoot: string): string {
    const key = normalizeRepoRoot(repoRoot);
    if (!this.roots.has(key)) {
      this.roots.set(key, path.normalize(path.resolve(repoRoot)));
      this.generations.set(key, 0);
    }
    return key;
  }
}

function runtimeDiagnostic(
  uri: vscode.Uri,
  diagnostic: vscode.Diagnostic
): RuntimeDiagnostic {
  return {
    path: uri.fsPath,
    range: {
      startLine: diagnostic.range.start.line,
      startCharacter: diagnostic.range.start.character,
      endLine: diagnostic.range.end.line,
      endCharacter: diagnostic.range.end.character
    },
    severity: runtimeSeverity(diagnostic.severity),
    message: diagnostic.message,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code === undefined
      ? {}
      : {
          code:
            typeof diagnostic.code === 'object'
              ? diagnostic.code.value
              : diagnostic.code
        })
  };
}

function runtimeSeverity(
  severity: vscode.DiagnosticSeverity
): RuntimeDiagnostic['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
