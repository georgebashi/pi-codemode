# Pi Code Mode Extension — Implementation Plan

## Overview

A Pi extension that replaces most of Pi's tools with a single `execute_tools` tool. Instead of calling tools individually, the LLM writes TypeScript code that calls tools as functions. This reduces context window usage, minimizes round-trips, and plays to LLMs' strength at writing code.

Based on Cloudflare's "Code Mode" pattern:
- https://blog.cloudflare.com/code-mode/
- https://blog.cloudflare.com/code-mode-mcp/

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  LLM Context                                        │
│                                                     │
│  System prompt includes:                            │
│  - TypeScript type definitions for built-in tools   │
│  - Instructions for code mode                       │
│  - MCP tools available via progressive discovery    │
│                                                     │
│  Active tools:                                      │
│  - execute_tools (run TS code against tool APIs)    │
│  - edit (kept direct — diff rendering is valuable)  │
└───────────┬─────────────────────────────────────────┘
            │ LLM writes TS code
            ▼
┌─────────────────────────────────────────────────────┐
│  execute_tools                                      │
│                                                     │
│  1. Receive TS code string from LLM                 │
│  2. Type-check against tool API declarations (tsc)  │
│     - Catches: wrong param types, missing params,   │
│       non-existent tools, wrong return type usage   │
│     - ~2ms per check (lib files pre-loaded)         │
│  3. Strip types via esbuild (~0.1ms)                │
│  4. Execute JS in Node vm.Context with bindings:    │
│     - tools.read(...)                               │
│     - tools.bash(...)                               │
│     - tools.write(...)                              │
│     - tools.mcp(...)                                │
│     - tools.search_tools(...)                       │
│     - console.log(...)  (captured)                  │
│     - progress(...)     (streamed)                  │
│  5. Return: { returnValue, logs, errors? }          │
└───────────┬─────────────────────────────────────────┘
            │ Bindings call real tool implementations
            ▼
┌─────────────────────────────────────────────────────┐
│  Tool Implementations (internal, hidden from LLM)   │
│                                                     │
│  Built-in: createCodingTools(cwd) from pi           │
│  MCP: proxy through pi-mcp-adapter's mcp tool       │
└─────────────────────────────────────────────────────┘
```

## Design Decisions

1. **Full TypeScript type-checking via `typescript` compiler** — The LLM writes TypeScript with type annotations against our declared `tools` API. Before execution, we run the code through `ts.createProgram` with a virtual file system containing the tool type definitions and ES2022 lib files. This catches:
   - Wrong parameter types (`tools.read({ path: 42 })` → "Type 'number' is not assignable to type 'string'")
   - Missing required parameters (`tools.read({})` → "Property 'path' is missing")
   - Non-existent tools (`tools.delete(...)` → "Property 'delete' does not exist")
   - Wrong return type usage (`const x: number = await tools.read(...)` → "Type 'string' is not assignable to type 'number'")
   - Syntax errors (`const x: = 42` → "Type expected")

   **Performance:** ~2ms per check after warmup (lib files are pre-parsed once into `ts.SourceFile` objects and reused). The one-time lib loading cost is ~50ms at extension init.

   After type-checking passes, esbuild strips types to JS in <1ms for execution.

2. **`edit` stays direct** — Pi's edit tool has excellent diff rendering and the LLM is well-trained on its exact format. It stays as a directly callable tool alongside `execute_tools`.

3. **`vm` module for execution** — Not a security sandbox (the LLM already has bash). Provides a clean namespace with only our bindings. Async/await works fine in vm contexts.

4. **Progressive disclosure for MCP** — Built-in tool types go in the system prompt (small, fixed). MCP tool types are discoverable via `tools.search_tools()` inside code, keeping the prompt small regardless of how many MCP servers are connected.

5. **Errors thrown and returned** — If code crashes mid-execution (even after side effects), the error is captured and returned to the LLM for self-correction. Type errors are caught *before* execution, so no side effects occur for type-invalid code.

6. **Streaming via `progress()`** — A `progress(text)` function is available in the sandbox. Calls stream updates to the UI via `onUpdate`.

## File Structure

```
pi-codemode/
├── package.json
├── tsconfig.json
├── PLAN.md
├── src/
│   ├── index.ts              # Extension entry point
│   ├── execute-tool.ts       # The execute_tools tool definition
│   ├── type-checker.ts       # TypeScript type-checking pipeline
│   ├── sandbox.ts            # vm context creation & code execution
│   ├── type-generator.ts     # Generate TS type definitions from tool schemas
│   ├── tool-bindings.ts      # Create tool binding functions for the sandbox
│   └── system-prompt.ts      # System prompt injection for code mode
```

## Implementation Steps

### Phase 1: Project Setup

**File: `package.json`**
```json
{
  "name": "pi-codemode",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "typescript": "^5.8.0",
    "esbuild": "^0.25.0"
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

**File: `tsconfig.json`**
- Standard TS config, target ESNext, module NodeNext

### Phase 2: Type Checker (`src/type-checker.ts`)

The core innovation: full TS type-checking of LLM-generated code against our tool API.

**Initialization (once at extension load):**
1. Load ES2022 lib `.d.ts` files from the typescript package, pre-parse them into `ts.SourceFile` objects (Map<string, SourceFile>). This takes ~50ms once and is reused for all subsequent checks.
2. Store the tool type definitions string (updated when MCP tools are discovered).

**`typeCheck(userCode: string, typeDefs: string): TypeCheckResult`**
1. Concatenate: `typeDefs + "\n(async () => {\n" + userCode + "\n})();\n"`
2. Create a `ts.SourceFile` for the concatenated code
3. Create a virtual `CompilerHost` that serves our source file + pre-loaded lib files
4. Create a `ts.Program` with strict mode, noEmit, skipLibCheck
5. Get syntactic + semantic diagnostics for our file only (not lib files)
6. Map diagnostic positions back to user code line numbers (subtract type def prefix lines)
7. Return errors array with line numbers and messages

**Return type:**
```typescript
interface TypeCheckResult {
  errors: Array<{
    line: number;   // Line in user's code (1-indexed)
    message: string; // TS error message
  }>;
}
```

### Phase 3: Type Generator (`src/type-generator.ts`)

Produces the TypeScript declarations that are both:
- Injected into the system prompt (so the LLM knows the API)
- Fed to the type checker (so it can validate code)

**Functions:**
- `generateBuiltinTypeDefs(): string` — Hand-crafted TS declarations for built-in tools. These are stable and well-known, so hand-writing produces better docs than auto-generating from schema.
- `generateMcpTypeDef(toolName: string, description: string, inputSchema: unknown): string` — Auto-generate a TS interface from a JSON Schema (for progressive disclosure results). Used when `search_tools()` returns results with type info.

**Built-in type surface (goes into system prompt AND type checker):**

```typescript
/** Tool API available inside execute_tools code blocks. */
declare const tools: {
  /**
   * Read a file. Returns the file content as a string.
   * Images (jpg, png, gif, webp) cannot be read this way.
   * Default limit: 2000 lines or 50KB.
   */
  read(params: {
    /** Path to the file (relative or absolute) */
    path: string;
    /** Line number to start from (1-indexed) */
    offset?: number;
    /** Maximum lines to read */
    limit?: number;
  }): Promise<string>;

  /**
   * Execute a bash command. Returns stdout+stderr combined.
   * Output is truncated to 2000 lines / 50KB.
   */
  bash(params: {
    /** The bash command to execute */
    command: string;
    /** Timeout in seconds */
    timeout?: number;
  }): Promise<{ output: string; exitCode: number }>;

  /**
   * Write content to a file. Creates parent directories automatically.
   * Overwrites existing files.
   */
  write(params: {
    /** Path to the file */
    path: string;
    /** Content to write */
    content: string;
  }): Promise<void>;

  /**
   * Search for available MCP and pi tools by name/description.
   * Returns tool names, descriptions, and TypeScript type signatures.
   * Use this to discover tools before calling them via tools.mcp().
   */
  search_tools(params: {
    /** Search query (space-separated terms, OR'd) */
    query: string;
  }): Promise<string>;

  /**
   * Call an MCP tool by name.
   * Use search_tools() first to discover available tools and their parameters.
   */
  mcp(params: {
    /** Tool name (e.g., 'sourcegraph_search') */
    tool: string;
    /** Arguments as an object */
    args?: Record<string, unknown>;
    /** Optional: filter to specific server */
    server?: string;
  }): Promise<unknown>;

  /** Report progress to the user (streamed to UI in real-time). */
  progress(message: string): void;
};

/** Print output to include in the result returned to you. */
declare function print(...args: any[]): void;
```

### Phase 4: Tool Bindings (`src/tool-bindings.ts`)

Creates the JavaScript functions that back the type declarations at runtime.

**`createToolBindings(cwd, mcpExecute, signal, onUpdate): ToolBindings`**

Each binding wraps a real tool and returns simplified values:

- `tools.read(params)` → calls `readTool.execute(...)`, extracts text content, returns `string`
- `tools.bash(params)` → calls `bashTool.execute(...)`, returns `{ output: string; exitCode: number }`
- `tools.write(params)` → calls `writeTool.execute(...)`, returns `void`
- `tools.mcp(params)` → calls the mcp tool's execute, returns the content
- `tools.search_tools(params)` → searches MCP metadata + pi tools, returns formatted string with TS type signatures
- `tools.progress(msg)` → calls `onUpdate` to stream to UI
- `print(...)` → appends to captured logs array

**Simplification principle:** Bindings return clean values (string, object), not the raw `{ content: [...], details: {...} }` envelopes. This makes LLM code natural and readable.

### Phase 5: Sandbox (`src/sandbox.ts`)

The execution environment using Node's `vm` module.

**`executeCode(tsCode, typeDefs, bindings, signal): Promise<ExecutionResult>`**

Pipeline:
1. **Type check** via `type-checker.ts` → if errors, return them immediately (no execution, no side effects)
2. **Strip types** via `esbuild.transformSync(wrappedCode, { loader: 'ts' })` → JS code
3. **Create vm context** with:
   - `tools` — the tool bindings
   - `print` — captured log function
   - `console.log` — also captured
   - Standard globals: `JSON`, `Array`, `Object`, `Map`, `Set`, `Math`, `Date`, `RegExp`, `Promise`, `setTimeout`, `Error`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`
   - NOT available: `require`, `process`, `fs`, `fetch`, `globalThis`
4. **Execute** `vm.runInContext(code, context, { timeout: 120_000 })` — 2 minute timeout
5. **Return** `{ success, returnValue, logs, errors }`

### Phase 6: The `execute_tools` Tool (`src/execute-tool.ts`)

The registered Pi tool.

```typescript
pi.registerTool({
  name: "execute_tools",
  label: "Execute Tools",
  description: "Execute TypeScript code that calls tools as typed functions. ..."
  parameters: Type.Object({
    code: Type.String({ description: "TypeScript code body. Has access to tools.read(), tools.bash(), tools.write(), tools.mcp(), tools.search_tools(), and print()." })
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const result = await executeCode(params.code, typeDefs, bindings, signal);
    if (!result.success) {
      // Format type/runtime errors for the LLM
      const errorText = result.errors.map(e => `Line ${e.line}: ${e.message}`).join('\n');
      return {
        content: [{ type: "text", text: `Type/execution errors:\n${errorText}\n\nFix your code and try again.` }],
        isError: true,
        details: { errors: result.errors },
      };
    }
    // Format success: logs + return value
    let text = '';
    if (result.logs.length > 0) text += result.logs.join('\n') + '\n';
    if (result.returnValue !== undefined) {
      text += typeof result.returnValue === 'string'
        ? result.returnValue
        : JSON.stringify(result.returnValue, null, 2);
    }
    return {
      content: [{ type: "text", text: text || "(no output)" }],
      details: { logs: result.logs, returnValue: result.returnValue },
    };
  },
  renderCall(args, theme) { /* syntax-highlighted TS code */ },
  renderResult(result, options, theme) { /* formatted output/logs/errors */ },
});
```

### Phase 7: System Prompt Injection (`src/system-prompt.ts`)

Modifies the system prompt via `before_agent_start`.

**Injected content:**
```markdown
## Code Mode

You have access to tools through TypeScript code execution. Instead of calling tools
individually, write TypeScript code that calls multiple tools and returns just what you need.

Your code is **type-checked** against the tool API before execution. Type errors will be
returned to you for correction — no side effects occur until types are valid.

### Available Tool API

{typeDefinitions}

### How to use

Call `execute_tools` with a TypeScript code body. Your code runs with the `tools.*` API
available. Use `print()` to output intermediate results and `return` for the final value.

Example — find all TODO comments in TypeScript files:
```ts
const result = await tools.bash({ command: "grep -rn 'TODO' --include='*.ts' ." });
const lines = result.output.split('\n').filter(l => l.trim());
print(`Found ${lines.length} TODOs`);
return lines.slice(0, 20);
```

Example — read multiple files and extract data:
```ts
const pkg = await tools.read({ path: "package.json" });
const deps = Object.keys(JSON.parse(pkg).dependencies || {});
const results: Record<string, number> = {};
for (const dep of deps) {
  const r = await tools.bash({ command: `grep -rn "from '${dep}'" --include='*.ts' . | wc -l` });
  results[dep] = parseInt(r.output.trim());
}
return results;
```

### Important
- Use `tools.search_tools()` to discover MCP tools before calling `tools.mcp()`
- The `edit` tool is available directly (not through code) for file modifications
- Both `print()` output and `return` values are included in the result
- Type errors are caught before execution — fix them based on the error messages
- Runtime errors are caught and returned — fix your code if you see one
```

### Phase 8: Extension Entry Point (`src/index.ts`)

```typescript
export default function(pi: ExtensionAPI) {
  // 1. Initialize type checker
  //    - Load TS lib files from typescript package
  //    - Generate built-in type definitions

  // 2. Create tool instances
  //    - createCodingTools(cwd) for built-in tools (read, bash, write)
  //    - Get mcp tool reference from pi.getAllTools() for MCP proxy

  // 3. Register execute_tools tool
  //    - Uses type-checker.ts for validation
  //    - Uses sandbox.ts for execution
  //    - Uses tool-bindings.ts for the runtime API

  // 4. On session_start:
  //    - pi.setActiveTools(["execute_tools", "edit"])
  //    - (hides individual tools; mcp accessed through sandbox)

  // 5. On before_agent_start:
  //    - Inject type definitions + instructions into system prompt

  // 6. Register /codemode command:
  //    - Toggle code mode on/off
  //    - Off: restore all original tools
  //    - On: hide tools, show execute_tools + edit

  // 7. Register --no-codemode flag:
  //    - Disable the extension entirely
}
```

### Phase 9: Custom Rendering

**`renderCall(args, theme)`:** Shows the TypeScript code with syntax highlighting using Pi's `highlightCode("typescript", ...)`.

**`renderResult(result, options, theme)`:**
- **Type errors:** Red-highlighted error messages with line numbers
- **Success:** Return value (JSON-formatted if object, plain if string) + captured logs
- **Runtime errors:** Error message with stack trace line reference
- **Supports expanded view** (`Ctrl+O`): collapsed shows summary, expanded shows full output

### Phase 10: Configuration & Polish

- **`--no-codemode` flag** — Disable the extension
- **`/codemode` command** — Toggle on/off mid-session
- **Config file** — `.pi/codemode.json` for settings:
  - `keepDirectTools: string[]` — tools to keep direct (default: `["edit"]`)
  - `timeout: number` — execution timeout in seconds (default: 120)
  - `maxOutputSize: number` — max output size in bytes (default: 50KB)

## Token Budget Analysis

**Without code mode (current):**
- read tool: ~200 tokens
- bash tool: ~200 tokens
- write tool: ~150 tokens
- edit tool: ~400 tokens
- mcp tool: ~300 tokens (+ description listing servers)
- Total: ~1,250 tokens for tool definitions

**With code mode:**
- execute_tools: ~100 tokens (tool definition)
- edit: ~400 tokens (kept direct)
- Type definitions in system prompt: ~400 tokens
- Total: ~900 tokens

The savings grow dramatically with MCP tools. Each MCP direct tool adds ~100-200 tokens. With 50 MCP tools, that's 5,000-10,000 tokens. Code mode keeps it constant via progressive disclosure.

**The real win is round-trips:** A common pattern like "read file A, grep for X, read the matching files, extract Y" takes 5+ tool calls normally. In code mode, it's 1 call.

## Verified Performance

Prototype benchmarks (from prototype testing):

| Step | Time | Notes |
|------|------|-------|
| Type check (cold) | ~7ms | First check after init |
| Type check (warm) | ~2ms | Subsequent checks (lib files cached) |
| esbuild strip | <1ms | Syntax validation + type stripping |
| vm execution | varies | Depends on tool calls |
| **Full pipeline** | **~35ms + tools** | Type check + strip + execute |

Lib file loading (one-time init): ~50ms for 53 ES2022 lib files.

## Testing Strategy

1. **Unit tests for type-checker** — verify all error categories are caught
2. **Unit tests for sandbox** — verify execution, error handling, timeout, globals
3. **Unit tests for type-generator** — verify schema → TS conversion for MCP
4. **Integration test** — full pipeline: TS code → type check → strip → execute → result
5. **Manual testing** — use with Pi interactively:
   - "Read package.json and list all dependencies"
   - "Find all files importing X and count them"
   - "Search MCP tools for Jira, then create a ticket"
   - Intentional type errors to verify rejection + correction

## Future Improvements

- **Incremental type checking** — Reuse program state across checks for even faster validation
- **MCP type caching** — Cache generated MCP type definitions across sessions
- **Smart mode switching** — Auto-detect when a task benefits from code mode vs. direct tools
- **Watch mode** — Re-type-check on tool API changes (new MCP connections)
- **Richer return types** — Let tools return structured data (images from read, etc.)
