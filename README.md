# pi-codemode

**What if your coding agent could write real code to call its own tools — with type-checking, parallelism, and shell access — in a single round-trip?**

[![npm version](https://img.shields.io/npm/v/@georgebashi/pi-codemode?style=for-the-badge)](https://www.npmjs.com/package/@georgebashi/pi-codemode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

## Why

- **Fewer round-trips** — "read file A, grep for X, read matches, extract Y" takes 5+ individual tool calls. In code mode, it's one call.
- **Type-safe** — TypeScript type-checking catches wrong parameter types, missing fields, and non-existent tools *before* any code runs.
- **Tiny context usage** — installing lots of MCP tools normally costs thousands of tokens. Code mode keeps it constant: one tool definition + compact type defs. MCP details are discovered on-demand.
- **Any npm package as a tool** — Add `simple-git`, `octokit`, `yaml`, `csv-parse`, or any npm package to the sandbox. Auto-installed, auto-typed, available as globals.
- **Shell built in** — zx template literals with automatic argument escaping and output truncation.

Inspired by Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode/) pattern.

## Install

```bash
pi install npm:@georgebashi/pi-codemode
```

Run once without installing:

```bash
pi -e npm:@georgebashi/pi-codemode
```

> **Note:** pi-codemode bundles [pi-mcp-adapter](https://github.com/nichochar/pi-mcp-adapter) for MCP integration. If you have `pi-mcp-adapter` installed separately, uninstall it first (`pi uninstall pi-mcp-adapter`). Your MCP config files will be picked up by this extension and provided to the TypeScript sandbox.

## Quick Start

Once loaded, code mode replaces Pi's individual tools with a single `execute_tools` tool. The LLM writes TypeScript that calls tools as functions:

```typescript
// Read 3 files at once
const [pkg, readme, config] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "README.md" }),
  tools.read({ path: "tsconfig.json" }),
]);
return Object.keys(JSON.parse(pkg).dependencies || {});
```

```typescript
// Shell commands with automatic escaping
const result = await $`grep -rn "TODO" --include='*.ts' src`;
print(result.stdout);
```

```typescript
// Discover and call MCP tools
const details = await tools.describe_tools({ namespace: "slack", tool: "post_message" });
await tools.slack.post_message({ channel: "#general", text: "Hello!" });
```

## Adding Packages

Any npm package can be injected into the sandbox as a global. Packages are auto-installed into a dedicated directory — your project's `node_modules` is never touched. TypeScript types are resolved automatically.

**Project-local** — `.pi/codemode.json`:

```jsonc
{
  "packages": {
    // Just a version string for packages that work out of the box
    "simple-git": "^3.33.0",
    "@octokit/graphql": "^8.0.0",
    "csv-parse": "^5.0.0",
    // Use an object to customize the variable name
    "yaml": { "version": "^2.8.0", "as": "YAML" }
  }
}
```

**Global** (all projects) — `~/.pi/agent/codemode.json`, same format.

### Package config options

| Field | Description |
|-------|-------------|
| `version` | npm version range (required) |
| `as` | Global variable name in the sandbox. Default: camelCased package name |
| `export` | Pick a specific named export instead of the full module namespace |
| `hint` | Usage hint shown to the LLM in the system prompt |
| `description` | Custom description (default: from package.json) |

**Auto-detection:** When a module has a named export matching the variable name (e.g., `require('simple-git').simpleGit`), it's picked automatically — the agent gets the callable factory and can write `simpleGit()` exactly like the library docs. Use `export` to override this when the auto-detection doesn't match what you want.

Then the LLM uses them directly — code matches library docs:

```typescript
// Git operations — exactly like simple-git docs
const git = simpleGit();
const status = await git.status();
const log = await git.log({ maxCount: 5 });

// Works for any repo path
const other = simpleGit('/path/to/other/repo');
```

```typescript
// YAML parsing
const config = YAML.parse(await tools.read({ path: "config.yml" }));
```

```typescript
// GitHub GraphQL API
const { repository } = await graphql(`{
  repository(owner: "org", name: "repo") {
    pullRequests(last: 10, states: OPEN) {
      nodes { title, author { login }, createdAt }
    }
  }
}`, { headers: { authorization: `bearer ${process.env.GITHUB_TOKEN}` } });
return repository.pullRequests.nodes;
```

## Commands

| Command | Description |
|---------|-------------|
| `/codemode` | Toggle code mode on/off |
| `--no-codemode` | Disable code mode entirely (CLI flag) |

## License

MIT
