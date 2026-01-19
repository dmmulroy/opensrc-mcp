import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getGlobalOpensrcDir } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  data?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
  };
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let logFilePath: string | null = null;
let minLevel: LogLevel = "debug";

/**
 * Get the log file path (creates logs dir if needed)
 */
async function getLogFilePath(): Promise<string> {
  if (logFilePath) return logFilePath;

  const opensrcDir = getGlobalOpensrcDir();
  const logsDir = join(opensrcDir, "logs");

  if (!existsSync(logsDir)) {
    await mkdir(logsDir, { recursive: true });
  }

  logFilePath = join(logsDir, "opensrc-mcp.log");
  return logFilePath;
}

/**
 * Set minimum log level
 */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * Get current log file path for tailing
 */
export function getLogPath(): string {
  const opensrcDir = getGlobalOpensrcDir();
  return join(opensrcDir, "logs", "opensrc-mcp.log");
}

/**
 * Write a structured log entry to file
 */
async function writeLog(entry: LogEntry): Promise<void> {
  if (LOG_LEVELS[entry.level] < LOG_LEVELS[minLevel]) {
    return;
  }

  try {
    const path = await getLogFilePath();
    const line = JSON.stringify(entry) + "\n";
    await appendFile(path, line, "utf8");
  } catch {
    // Silently fail - don't break app if logging fails
  }
}

/**
 * Create a log entry
 */
function createEntry(
  level: LogLevel,
  message: string,
  context?: string,
  data?: Record<string, unknown>,
  error?: Error
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  if (context) entry.context = context;
  if (data) entry.data = data;
  if (error) {
    entry.error = {
      message: error.message,
      stack: error.stack,
    };
  }

  return entry;
}

/**
 * Logger interface for a specific context
 */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, errorOrData?: Error | Record<string, unknown>): void;
}

/**
 * Create a logger for a specific context (e.g., "vector", "server")
 */
export function createLogger(context: string): Logger {
  return {
    debug(message: string, data?: Record<string, unknown>) {
      void writeLog(createEntry("debug", message, context, data));
    },

    info(message: string, data?: Record<string, unknown>) {
      void writeLog(createEntry("info", message, context, data));
    },

    warn(message: string, data?: Record<string, unknown>) {
      void writeLog(createEntry("warn", message, context, data));
    },

    error(message: string, errorOrData?: Error | Record<string, unknown>) {
      const isError = errorOrData instanceof Error;
      void writeLog(
        createEntry(
          "error",
          message,
          context,
          isError ? undefined : errorOrData,
          isError ? errorOrData : undefined
        )
      );
    },
  };
}

/**
 * Root logger (no context)
 */
export const log = createLogger("main");
