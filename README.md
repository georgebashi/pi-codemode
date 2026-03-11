# pi-codemode

**What if your coding agent could write real code to call its own tools — with type-checking, parallelism, and shell access — in a single round-trip?**

[![npm version](https://img.shields.io/npm/v/@georgebashi/pi-codemode?style=for-the-badge)](https://www.npmjs.com/package/@georgebashi/pi-codemode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

## Why

- **Fewer round-trips** — "read file A, grep for X, read matches, extract Y" takes 5+ individual tool calls. In code mode, it's one `execute_tools` call.
- **Type-safe** — Full TypeScript type-checking catches wrong parameter types, missing required fields, and non-existent tools *before* any code runs. The LLM gets actionable errors and self-corrects.
- **Tiny context window** — Without code mode, 50 MCP tools cost 5,000–10,000 tokens. Code mode keeps it constant: one tool definition (~100 tokens) + compact type defs. MCP details are discovered on-demand.
- **Shell built in** — zx template literals with automatic argument escaping, output truncation, and streaming. No separate bash tool needed.
- **Parallel by default** — `Promise.all` for concurrent file reads, shell commands, and MCP calls. The LLM learns this pattern fast.

Inspired by Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode/) pattern.

## Install

```bash
pi install npm:@georgebashi/pi-codemode
```

Or via git:

```bash
pi install https://github.com/georgebashi/pi-codemode
```

Run once without installing:

```bash
pi -e npm:@georgebashi/pi-codemode
```

## Quick Start

Once loaded, code mode replaces Pi's individual tools with a single `execute_tools` tool. The LLM automatically writes TypeScript that calls tools as functions:

```typescript
// Read 3 files at once — 3x faster than sequential tool calls
const [pkg, readme, tsconfig] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "README.md" }),
  tools.read({ path: "tsconfig.json" }),
]);
return { deps: Object.keys(JSON.parse(pkg).dependencies || {}), hasReadme: readme.length > 0 };
```

```typescript
// Shell commands with automatic escaping
const result = await $\`grep -rn "TODO" --include='*.ts' src\`;
print(result.stdout);
```

```typescript
// Discover and call MCP tools — no upfront cost
const details = await tools.describe_tools({ namespace: "slack", tool: "channels_me" });
const channels = await tools.slack.channels_me({ channel_types: "im", limit: 20 });
return channels;
```

```typescript
// Chain: find files → read them → extract data
const found = await $\`find src -name '*.test.ts'\`;
const files = found.stdout.split('\n').filter(f => f.trim());
const contents = await Promise.all(files.map(f => tools.read({ path: f })));
const tests = contents.flatMap((c, i) => {
  const matches = c.match(/it\\(['"](.+?)['"]/g) || [];
  return matches.map(m => ({ file: files[i], test: m }));
});
return tests;
```

## Features

### TypeScript Type-Checking

Every code block is validated with `ts.createProgram` against the full tool API before execution. Type mismatches, missing params, and unknown tools are caught instantly — no side effects until types are valid.

```
Type errors (code was NOT executed):
Line 3: Argument of type '{ pat: string }' is not assignable to parameter.
  Object literal may only specify known properties, and 'pat' does not exist in type '{ path: string }'.
```

~2ms per check after warmup. The LLM sees the error, fixes the typo, and retries — all without any files being touched.

### Shell via zx

Full [zx](https://google.github.io/zx/) integration with template literals, automatic argument escaping, and output truncation:

```typescript
// Arguments are automatically escaped — safe with any input
const file = "path with spaces/file.ts";
const result = await $\`cat ${file}\`;

// Parallel shell commands
const [status, branch] = await Promise.all([
  $\`git status --porcelain\`,
  $\`git branch --show-current\`,
]);
```

Output is tail-truncated to 2000 lines / 50KB. Full output is saved to a temp file and the path is shown in the truncation notice.

### MCP Integration

All MCP servers appear as typed namespaces. Metadata is loaded from cache (instant, no connections needed). Servers connect lazily on first actual tool call.

```typescript
// Browse available tools
const slackTools = await tools.describe_tools({ namespace: "slack" });

// Search across all servers
const found = await tools.search_tools({ query: "send message" });

// Call with full type-checking
const result = await tools.slack.post_message({ channel: "#general", text: "Hello!" });
```

### Progressive Discovery

The system prompt stays small. Instead of dumping all tool schemas upfront:

| Approach | Context cost |
|----------|-------------|
| Traditional (50 MCP tools) | 5,000–10,000 tokens |
| Code mode | ~500 tokens (fixed) |

The LLM uses `search_tools()` (fuzzy full-text search via MiniSearch) and `describe_tools()` to find and inspect tools at runtime. Only what's needed enters the context.

### User Packages

Configure additional npm packages to be available as globals in the sandbox. Packages are auto-installed into dedicated directories — your project's `node_modules` is never touched.

**Project-local** — `.pi/codemode.json`:

```jsonc
{
  "packages": {
    "lodash": ">=4.17.21",
    "csv-parse": { "version": "^5.0.0", "as": "csvParse" }
  }
}
```

**Global** (all projects) — `~/.pi/agent/codemode.json`:

```jsonc
{
  "packages": {
    "simple-git": { "version": "^3.33.0", "as": "git" },
    "yaml": { "version": "^2.8.0", "as": "YAML" }
  }
}
```

TypeScript types are automatically resolved — from the package itself, from `@types/*`, or falling back to `any`.

### Custom Rendering

Code blocks are syntax-highlighted in the TUI. Results show a compact summary by default with full output available via Ctrl+O:

| View | What's shown |
|------|-------------|
| Collapsed | ✓ First 3 lines + "N more lines" |
| Expanded | Full output |
| Error (collapsed) | ✗ First error message |
| Error (expanded) | All errors with line numbers |
| Streaming | "Executing..." with progress updates |

## Commands

| Command | Description |
|---------|-------------|
| `/codemode` | Toggle code mode on/off |
| `--no-codemode` | Disable code mode entirely (CLI flag) |

## Configuration

### User packages

| Location | Config file | Install directory |
|----------|------------|-------------------|
| Global | `~/.pi/agent/codemode.json` | `~/.pi/agent/codemode-packages/` |
| Project | `.pi/codemode.json` | `.pi/codemode-packages/` |

Project packages override global packages for the same variable name. User packages can also override built-in globals (`fs`, `path`, `os`, `$`, etc.).

### Built-in globals

These are always available in the sandbox without any configuration:

| Global | Source | Description |
|--------|--------|-------------|
| `tools.*` | pi-codemode | File I/O, MCP, search, progress |
| `$` | zx | Shell commands via template literals |
| `cd`, `within`, `nothrow`, `quiet` | zx | Shell utilities |
| `retry`, `sleep`, `spinner`, `echo` | zx | Flow control |
| `glob`, `which`, `quote` | zx | File finding, path lookup, escaping |
| `chalk` | zx | Terminal string styling |
| `fs` | fs-extra | Enhanced file system operations |
| `path`, `os` | Node.js | Path manipulation, OS info |
| `print()` | pi-codemode | Output capture (like `console.log`) |
| `JSON`, `YAML` | built-in | Parse and serialize data |

## Performance

| Step | Time | Notes |
|------|------|-------|
| Lib loading (one-time) | ~150ms | 53 ES2022 lib files + @types + zx |
| Type check | ~2ms | After warmup (lib files cached) |
| esbuild strip | <1ms | Type stripping only |
| **Full pipeline** | **~5ms + tool calls** | Type check → strip → execute |

## How It Works

```
┌─────────────────────────────────────────────────┐
│  LLM writes TypeScript code                     │
│                                                 │
│  const [pkg, readme] = await Promise.all([      │
│    tools.read({ path: "package.json" }),         │
│    tools.read({ path: "README.md" }),            │
│  ]);                                            │
│  return Object.keys(JSON.parse(pkg).deps);      │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│  Pipeline                                       │
│                                                 │
│  1. Type-check against tool API (TypeScript)    │
│  2. Strip types (esbuild, <1ms)                 │
│  3. Execute in Node.js VM sandbox               │
│  4. Return result (or type/runtime errors)      │
└─────────────────────────────────────────────────┘
```

### Source files

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry point — registers tool, commands, lifecycle hooks |
| `src/execute-tool.ts` | The `execute_tools` tool definition with rendering |
| `src/type-checker.ts` | TypeScript type-checking with virtual file system |
| `src/type-generator.ts` | Generates TS declarations from tool schemas + JSON Schema → TS |
| `src/sandbox.ts` | VM execution, zx shell integration, output truncation |
| `src/tool-bindings.ts` | Runtime bindings that back the type declarations |
| `src/mcp-client.ts` | MCP client with lazy connections and metadata cache |
| `src/search.ts` | Full-text tool search (MiniSearch) |
| `src/package-resolver.ts` | User package resolution, auto-install, and config loading |
| `src/system-prompt.ts` | System prompt injection with type defs and examples |

## Dependencies

- **[typescript](https://www.typescriptlang.org/)** — Type-checking LLM-generated code
- **[esbuild](https://esbuild.github.io/)** — Fast type stripping
- **[zx](https://google.github.io/zx/)** — Shell commands with template literals
- **[minisearch](https://lucaong.github.io/minisearch/)** — Full-text tool search
- **[pi-mcp-adapter](https://github.com/nichochar/pi-mcp-adapter)** — MCP server management and metadata cache
- **[fs-extra](https://github.com/jprichardson/node-fs-extra)** — Enhanced file system operations

## License

MIT
