# SQLite-Vector Extension Binaries

This directory contains platform-specific SQLite-Vector extension binaries for vector search support.

## Download Binaries

Download the appropriate binary for your platform from:
https://github.com/sqliteai/sqlite-vector/releases

### Expected Files

Place the downloaded binary in this directory with the following naming convention:

| Platform | Architecture | Filename |
|----------|--------------|----------|
| macOS | ARM64 (M1/M2/M3) | `vector.darwin-arm64.dylib` |
| macOS | x64 (Intel) | `vector.darwin-x64.dylib` |
| Linux | x64 | `vector.linux-x64.so` |
| Linux | ARM64 | `vector.linux-arm64.so` |
| Windows | x64 | `vector.win32-x64.dll` |

## Optional

The sqlite-vector extension is optional. If not present:
- The server will still start and work
- Vector search will not be available
- You can still use regex-based `grep()` for searching

## Quick Setup (macOS ARM64)

```bash
# Download latest release
curl -L https://github.com/sqliteai/sqlite-vector/releases/latest/download/vector-macos-arm64.dylib -o libs/vector.darwin-arm64.dylib
```

## Verify Installation

The extension is loaded on startup. Check the console output for:
- Success: No warning messages
- Failure: `Warning: Could not load sqlite-vector extension: ...`
