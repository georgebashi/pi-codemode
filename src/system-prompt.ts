// system-prompt.ts — System prompt injection for code mode.
//
// The system prompt gets:
// 1. Built-in tool type declarations (compact, ~400 tokens)
// 2. MCP server namespace listing (names + tool counts only)
// 3. Usage examples showing describe_tools → call workflow
//
// Full MCP type signatures live only in the type checker — the LLM uses
// describe_tools() to browse and search_tools() to search before calling.

/**
 * Generate the system prompt addition for code mode.
 *
 * @param builtinTypeDefs - TypeScript type declarations for built-in tools only
 * @param mcpSummary - Compact MCP server summary (namespace names only)
 */
export function generateSystemPromptAddition(
  builtinTypeDefs: string,
  mcpSummary: string
): string {
  return `\
## Code Mode

You have access to tools through TypeScript code execution. Instead of calling tools
individually, write TypeScript code that calls multiple tools and returns just what you need.

Your code is **type-checked** against the tool API before execution. Type errors are
returned for correction — no side effects occur until types are valid.

### Built-in Tool API

\`\`\`typescript
${builtinTypeDefs}
\`\`\`

### How to use

Call \`execute_tools\` with a TypeScript code body. Your code runs with the \`tools.*\` API
available. Use \`print()\` to output intermediate results and \`return\` for the final value.

#### Parallel execution — use Promise.all for independent calls

When you need data from multiple independent sources, **always** use \`Promise.all\` to
run them concurrently. This is significantly faster than sequential \`await\`s.

\`\`\`typescript
// Read 3 files at once — 3x faster than sequential awaits
const [pkg, readme, tsconfig] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "README.md" }),
  tools.read({ path: "tsconfig.json" }),
]);
return { deps: Object.keys(JSON.parse(pkg).dependencies || {}), hasReadme: readme.length > 0 };
\`\`\`

\`\`\`typescript
// Run independent commands in parallel
const [gitStatus, gitBranch, nodeVersion] = await Promise.all([
  $\`git status --porcelain\`,
  $\`git branch --show-current\`,
  $\`node --version\`,
]);
return {
  dirty: gitStatus.stdout.trim().length > 0,
  branch: gitBranch.stdout.trim(),
  node: nodeVersion.stdout.trim(),
};
\`\`\`

#### Chaining — use output of one call to drive the next

Chain calls when a later step depends on an earlier result.

\`\`\`typescript
// Step 1: Find files
const found = await $\`find src -name '*.test.ts'\`;
const files = found.stdout.split('\\n').filter(f => f.trim());

// Step 2: Read all found files in parallel
const contents = await Promise.all(
  files.map(f => tools.read({ path: f }))
);

// Step 3: Extract and aggregate
const tests = contents.flatMap((c, i) => {
  const matches = c.match(/it\\(['"](.+?)['"]/g) || [];
  return matches.map(m => ({ file: files[i], test: m }));
});
print(\`Found \${tests.length} tests across \${files.length} files\`);
return tests;
\`\`\`

#### Combining patterns — fan out after discovery

\`\`\`typescript
// Chain: read package.json → fan out to count usage of each dependency
const pkg = await tools.read({ path: "package.json" });
const deps = Object.keys(JSON.parse(pkg).dependencies || {});

const counts = await Promise.all(
  deps.map(async dep => {
    const r = await $\`grep -rn "from '\${dep}'" --include='*.ts' . | wc -l\`;
    return { dep, count: parseInt(r.stdout.trim()) };
  })
);
return counts.filter(c => c.count > 0);
\`\`\`
${mcpSummary ? `
${mcpSummary}

**Before calling an MCP tool, use \`describe_tools\` to see its parameters:**

\`\`\`typescript
// Step 1: Browse tools in a namespace
const slackTools = await tools.describe_tools({ namespace: "slack" });
print(slackTools);

// Step 2: Get full parameter details for a specific tool
const details = await tools.describe_tools({ namespace: "slack", tool: "channels_me" });
print(details);

// Step 3: Call with the correct parameters
const channels = await tools.slack.channels_me({ channel_types: "im", limit: 20 });
return channels;
\`\`\`

You can also use \`search_tools\` to find tools by keyword across all servers:
\`\`\`typescript
const found = await tools.search_tools({ query: "slack direct messages" });
print(found);
\`\`\`
` : ""}
### Utilities

- \`JSON.parse()\` / \`JSON.stringify()\` — parse and serialize JSON
- \`YAML.parse()\` / \`YAML.stringify()\` — parse and serialize YAML

### Important
- **Parallelize independent calls** — use \`Promise.all\` whenever calls don't depend on each other
- **Chain dependent calls** — use the result of one call to determine what to call next
- Both \`print()\` output and \`return\` values are included in the result
- Type errors are caught before execution — fix them based on the error messages
- Runtime errors are caught and returned — fix your code if you see one
`;
}
