import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_NULL_FIELDS = 100_000;

export interface GitRunOptions {
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  readonly maxStderrBytes?: number;
  readonly allowedExitCodes?: readonly number[];
}

export interface GitNullRunOptions extends GitRunOptions {
  readonly maxFields?: number;
}

export interface GitNullResult {
  readonly fields: readonly string[];
  readonly truncated: boolean;
  readonly bytesRead: number;
}

export interface GitRunner {
  text(
    cwd: string,
    args: readonly string[],
    options?: GitRunOptions
  ): Promise<string>;
  null(
    cwd: string,
    args: readonly string[],
    options?: GitNullRunOptions
  ): Promise<GitNullResult>;
}

export class GitCommandError extends Error {
  public constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export class GitOutputLimitError extends Error {
  public constructor(public readonly limit: number) {
    super(`Git output exceeded the ${limit}-byte safety limit`);
    this.name = 'GitOutputLimitError';
  }
}

export class GitAbortError extends Error {
  public constructor() {
    super('Git command was aborted');
    this.name = 'AbortError';
  }
}

export const defaultGitRunner: GitRunner = {
  text: runGitText,
  null: runGitNull
};

export function runGitText(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {}
): Promise<string> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return runGit(cwd, args, options, (stdout, stop) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    stdout.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (bytesRead > maxOutputBytes) {
        stop(new GitOutputLimitError(maxOutputBytes));
        return;
      }
      chunks.push(chunk);
    });
    return () => Buffer.concat(chunks).toString('utf8');
  });
}

export function runGitNull(
  cwd: string,
  args: readonly string[],
  options: GitNullRunOptions = {}
): Promise<GitNullResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxFields = options.maxFields ?? DEFAULT_MAX_NULL_FIELDS;
  return runGit(cwd, args, options, (stdout, stop) => {
    const parser = new NullFieldParser(maxFields);
    let bytesRead = 0;
    let truncated = false;
    stdout.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (bytesRead > maxOutputBytes) {
        truncated = true;
        stop();
        return;
      }
      if (!parser.push(chunk)) {
        truncated = true;
        stop();
      }
    });
    return () => ({
      fields: parser.finish(!truncated),
      truncated,
      bytesRead
    });
  });
}

/** Incrementally decodes NUL-delimited UTF-8 fields across arbitrary chunks. */
export class NullFieldParser {
  private readonly decoder = new StringDecoder('utf8');
  private readonly fields: string[] = [];
  private pending = '';

  public constructor(private readonly maxFields: number) {}

  public push(chunk: Buffer): boolean {
    const value = this.pending + this.decoder.write(chunk);
    const parts = value.split('\0');
    this.pending = parts.pop() ?? '';
    for (const part of parts) {
      if (this.fields.length >= this.maxFields) {
        return false;
      }
      this.fields.push(part);
    }
    return true;
  }

  public finish(includeTrailingField = true): readonly string[] {
    const tail = this.pending + this.decoder.end();
    if (includeTrailingField && tail && this.fields.length < this.maxFields) {
      this.fields.push(tail);
    }
    this.pending = '';
    return this.fields;
  }
}

function runGit<T>(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions,
  consume: (
    stdout: NodeJS.ReadableStream,
    stop: (error?: Error) => void
  ) => () => T
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GitAbortError());
      return;
    }
    const child = spawn('git', ['-C', cwd, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stderrChunks: Buffer[] = [];
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    let stderrBytes = 0;
    let stopped = false;
    let stopError: Error | undefined;
    const stop = (error?: Error): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      stopError = error;
      child.kill();
    };
    const finish = consume(child.stdout, stop);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxStderrBytes) {
        return;
      }
      const remaining = maxStderrBytes - stderrBytes;
      const retained = chunk.subarray(0, remaining);
      stderrChunks.push(retained);
      stderrBytes += retained.length;
    });
    const abort = (): void => stop(new GitAbortError());
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (exitCode) => {
      options.signal?.removeEventListener('abort', abort);
      if (stopError) {
        reject(stopError);
        return;
      }
      // A NUL collector deliberately stops after reaching its bound. Its
      // partial, complete fields are useful evidence and carry `truncated`.
      if (stopped) {
        resolve(finish());
        return;
      }
      const allowed = options.allowedExitCodes ?? [0];
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (exitCode === null || !allowed.includes(exitCode)) {
        reject(
          new GitCommandError(
            stderr || `Git exited with code ${String(exitCode)}`,
            exitCode,
            stderr
          )
        );
        return;
      }
      resolve(finish());
    });
  });
}
