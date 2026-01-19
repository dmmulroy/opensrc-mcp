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

// ── Database Errors ──────────────────────────────────────────────────────────

export class DatabaseError extends TaggedError("DatabaseError")<{
  operation: string;
  cause: unknown;
  message: string;
}>() {
  constructor(operation: string, cause: unknown) {
    super({
      operation,
      cause,
      message: `Database ${operation} failed`,
    });
  }
}

export class VectorExtensionError extends TaggedError("VectorExtensionError")<{
  extensionPath: string;
  cause: unknown;
  message: string;
}>() {
  constructor(extensionPath: string, cause: unknown) {
    super({
      extensionPath,
      cause,
      message: `sqlite-vector extension not found at ${extensionPath}`,
    });
  }
}

export class VectorExtensionNotAvailableError extends TaggedError("VectorExtensionNotAvailableError")<{
  message: string;
}>() {
  constructor() {
    super({ message: "sqlite-vector extension not available. See libs/README.md for installation." });
  }
}

// ── Platform Errors ──────────────────────────────────────────────────────────

export class UnsupportedPlatformError extends TaggedError("UnsupportedPlatformError")<{
  platform: string;
  arch: string;
  message: string;
}>() {
  constructor(platform: string, arch: string) {
    super({
      platform,
      arch,
      message: `Unsupported platform: ${platform}-${arch}`,
    });
  }
}

// ── Embedding Errors ─────────────────────────────────────────────────────────

export class EmbedderNotInitializedError extends TaggedError("EmbedderNotInitializedError")<{
  message: string;
}>() {
  constructor() {
    super({ message: "Embedder not initialized. Call initEmbedder() first." });
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

// ── Worker Errors ────────────────────────────────────────────────────────────

export class WorkerInitError extends TaggedError("WorkerInitError")<{
  cause: unknown;
  message: string;
}>() {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super({ cause, message: `Worker initialization failed: ${msg}` });
  }
}

export class DatabaseNotInitializedError extends TaggedError("DatabaseNotInitializedError")<{
  message: string;
}>() {
  constructor() {
    super({ message: "Database not initialized" });
  }
}

// ── Type Aliases for Error Unions ────────────────────────────────────────────

export type FileSystemError = PathTraversalError | FileNotFoundError | FileReadError;
export type VectorError = VectorExtensionError | VectorExtensionNotAvailableError | DatabaseError | EmbedderNotInitializedError;
export type SourceError = SourceNotFoundError | FileSystemError;
export type ExecutorError = CodeExecutionError | ExecutionTimeoutError;
