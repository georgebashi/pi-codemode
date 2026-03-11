# pi-codemode

A [Pi](https://github.com/nichochar/pi-coding-agent) extension that replaces most tools with a single `execute_tools` tool. Instead of calling tools individually, the LLM writes TypeScript code that calls tools as typed functions—reducing round-trips, saving context window, and catching errors before execution.

Inspired by Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode/) pattern.

## How it works

```
┌─────────────────────────────────────────────────┐
│  LLM writes TypeScript code                     │
│                                                 │
│  const [pkg, readme] = await Promise.all([      │
│    tools.read({ path: "package.json" }),         │
│    tools.read({ path: "README.md" }),            │
│  ]);                                            │
│  const deps = JSON.parse(pkg).dependencies;     │
│  return Object.keys(deps);                      │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│  execute_tools pipeline                         │
│                                                 │
│  1. Type-check against tool API (TypeScript)    │
│  2. Strip types (esbuild)                       │
│  3. Execute in Node.js VM sandbox               │
│  4. Return result (or type/runtime errors)      │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│  Tool implementations                           │
│                                                 │
│  Built-in: read, write, edit                    │
│  Shell: zx $ (with truncation + streaming)      │
│  MCP: lazy-connected server namespaces          │
│  Git: simple-git                                │
└─────────────────────────────────────────────────┘
```

**The key insight:** type-checking catches wrong parameter types, missing required fields, and non-existent tools *before* any code runs. The LLM gets actionable error messages and self-corrects.

## Features

- **TypeScript type-checking** — Full `ts.createProgram` validation against the tool API. Catches type mismatches, missing params, unknown tools (~2ms per check after warmup).
- **Shell via zx** — `$\`command\`` template literals with automatic argument escaping, output truncation (2000 lines / 50KB tail), and streaming to the UI.
- **MCP integration** — All MCP servers available as typed namespaces (`tools.slack.channels_me()`). Tool metadata loaded from cache (instant), servers connect lazily on first call.
- **Progressive discovery** — System prompt stays small. The LLM uses `search_tools()` (MiniSearch FTS) and `describe_tools()` to find and inspect tools at runtime.
- **Git** — Pre-configured `simple-git` instance available as `git` global.
- **YAML** — `YAML.parse()` / `YAML.stringify()` available in the sandbox.
- **Output truncation** — Shell output tail-truncated to 2000 lines / 50KB with full output saved to temp files. Binary/control characters sanitized.
- **Cancellation** — Abort signal support for cancelling long-running code.

## Installation

```bash
cd pi-codemode
npm install
```

Add to your Pi extensions config (`~/.pi/agent/extensions.json`):

```json
{
  "extensions": [
    "/path/to/pi-codemode/src/index.ts"
  ]
}
```

Or use the `pi` field in `package.json` (already configured):

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Usage

Once loaded, code mode replaces Pi's individual tools with `execute_tools`. The LLM automatically writes TypeScript that calls tools as functions.

### Built-in tools

```typescript
// Read files
const content = await tools.read({ path: "src/index.ts" });

// Write files
await tools.write({ path: "output.txt", content: "hello" });

// Edit files (find and replace)
await tools.edit({ path: "src/index.ts", oldText: "foo", newText: "bar" });

// Print output (captured and returned)
print("Found", results.length, "items");

// Return values (included in result)
return { count: 42, items: ["a", "b"] };
```

### Shell commands (zx)

```typescript
// Template literals with automatic escaping
const result = await $\`grep -rn "TODO" --include='*.ts' src\`;
print(result.stdout);

// Parallel commands
const [status, branch] = await Promise.all([
  $\`git status --porcelain\`,
  $\`git branch --show-current\`,
]);
```

### Git (simple-git)

```typescript
const status = await git.status();
const log = await git.log({ maxCount: 5 });
await git.add(".");
await git.commit("fix: resolve issue");
```

### MCP tools

```typescript
// Discover tools
const found = await tools.search_tools({ query: "slack channels" });

// Browse a namespace
const slackTools = await tools.describe_tools({ namespace: "slack" });

// Get full parameter details
const details = await tools.describe_tools({ namespace: "slack", tool: "channels_me" });

// Call MCP tools as typed functions
const channels = await tools.slack.channels_me({ channel_types: "im", limit: 20 });
```

### Parallel execution

```typescript
// Read multiple files concurrently
const [pkg, readme, config] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "README.md" }),
  tools.read({ path: "tsconfig.json" }),
]);
```

## Commands

| Command | Description |
|---------|-------------|
| `/codemode` | Toggle code mode on/off |
| `--no-codemode` | Disable code mode entirely (flag) |

## Architecture

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
| `src/search.ts` | Full-text search over all tools (MiniSearch) |
| `src/system-prompt.ts` | System prompt injection with type defs and examples |

### Pipeline

1. **LLM generates TypeScript** — guided by type definitions and examples in the system prompt
2. **Type-check** — `ts.createProgram` validates against tool API declarations (~2ms). Errors returned immediately, no side effects.
3. **Strip types** — esbuild removes TypeScript syntax (<1ms)
4. **Execute** — Code runs in a `node:vm` context with tool bindings and safe globals
5. **Return** — Success: logs + return value. Error: type errors or runtime errors with context.

### MCP integration

- **Instant discovery**: Tool metadata loaded from `pi-mcp-adapter`'s cache file (no connections needed)
- **Full type checking**: MCP tool schemas converted to TypeScript interfaces for the type checker
- **Lazy connections**: Servers only connect when a tool is actually called
- **Typed namespaces**: `tools.slack.channels_me()` instead of generic `tools.mcp({ tool: "channels_me" })`

### Type checking details

The type checker uses a virtual file system containing:
- ES2022 lib `.d.ts` files (pre-parsed once at init, ~150ms)
- `@types/node`, `@types/fs-extra`, `@types/jsonfile` for Node.js types
- `zx` type definitions for shell commands
- `simple-git` type definitions
- Tool API declarations (built-in + MCP)
- The user's code wrapped in an async IIFE

Error messages are enriched with JSDoc parameter documentation when available.

## Testing

```bash
npm test
```

Runs standalone tests for the type checker, sandbox, truncation, shell integration, and git integration. No Pi runtime required.

## Performance

| Step | Time | Notes |
|------|------|-------|
| Lib loading (one-time) | ~150ms | 53 ES2022 lib files + @types + zx |
| Type check | ~2ms | After warmup (lib files cached) |
| esbuild strip | <1ms | Type stripping only |
| **Full pipeline** | **~5ms + tool calls** | Type check + strip + execute |

## Token budget

Without code mode, each tool definition costs ~100–400 tokens. With 50 MCP tools, that's 5,000–10,000 tokens in the context window.

Code mode keeps it constant: one `execute_tools` definition (~100 tokens) + type definitions in the system prompt (~400 tokens) + compact MCP server listing. MCP tool details are discovered on-demand via `search_tools()` and `describe_tools()`.

The bigger win is **round-trips**: "read file A, grep for X, read matches, extract Y" takes 5+ individual tool calls. In code mode, it's one `execute_tools` call.

## Dependencies

- **[typescript](https://www.typescriptlang.org/)** — Type-checking LLM-generated code
- **[esbuild](https://esbuild.github.io/)** — Fast type stripping
- **[zx](https://google.github.io/zx/)** — Shell commands with template literals
- **[simple-git](https://github.com/steveukx/git-js)** — Git operations
- **[minisearch](https://lucaong.github.io/minisearch/)** — Full-text tool search
- **[yaml](https://eemeli.org/yaml/)** — YAML parsing/serialization
- **[pi-mcp-adapter](https://github.com/nichochar/pi-mcp-adapter)** — MCP server management and metadata cache
- **[fs-extra](https://github.com/jprichardson/node-fs-extra)** — Enhanced file system operations

## License

MIT
