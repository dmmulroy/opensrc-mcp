import { TaggedError } from "better-result";

// ── File System Errors ───────────────────────────────────────────────────────

export class PathTraversalError extends TaggedError("PathTraversalError")<{
  path: string;
  message: string;
}>() {
  constructor(path: string) {
    super({
      path,
      message: `Path traversal not allowed: ${path}`,
    });
  }
}

export class FileNotFoundError extends TaggedError("FileNotFoundError")<{
  path: string;
  message: string;
}>() {
  constructor(path: string) {
    super({ path, message: `File not found: ${path}` });
  }
}

export class FileReadError extends TaggedError("FileReadError")<{
  path: string;
  cause: unknown;
  message: string;
}>() {
  constructor(path: string, cause: unknown) {
    super({
      path,
      cause,
      message: `Failed to read file: ${path}`,
    });
  }
}

// ── Source Management Errors ─────────────────────────────────────────────────

export class SourceNotFoundError extends TaggedError("SourceNotFoundError")<{
  name: string;
  message: string;
}>() {
  constructor(name: string) {
    super({ name, message: `Source not found: ${name}` });
  }
}

// ── Executor Errors ──────────────────────────────────────────────────────────

export class ExecutionTimeoutError extends TaggedError("ExecutionTimeoutError")<{
  timeoutMs: number;
  message: string;
}>() {
  constructor(timeoutMs: number) {
    super({
      timeoutMs,
      message: `Execution timeout (${timeoutMs}ms)`,
    });
  }
}

export class CodeExecutionError extends TaggedError("CodeExecutionError")<{
  cause: unknown;
  message: string;
}>() {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super({ cause, message: msg });
  }
}

// ── Fetch Errors ─────────────────────────────────────────────────────────────

export class FetchError extends TaggedError("FetchError")<{
  spec: string;
  cause: unknown;
  message: string;
}>() {
  constructor(spec: string, cause: unknown) {
    super({
      spec,
      cause,
      message: `Failed to fetch: ${spec}`,
    });
  }
}

// ── Type Aliases for Error Unions ────────────────────────────────────────────

export type FileSystemError = PathTraversalError | FileNotFoundError | FileReadError;
export type SourceError = SourceNotFoundError | FileSystemError;
export type ExecutorError = CodeExecutionError | ExecutionTimeoutError;
