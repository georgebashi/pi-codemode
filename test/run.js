// test/run.js — Standalone test for type-checker + sandbox core logic.
// Tests the pipeline without needing pi's runtime.

const ts = require("typescript");
const esbuild = require("esbuild");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const YAML = require("yaml");

// ============================================================
// Inline the core logic for standalone testing
// (In production these come from the TS modules via jiti)
// ============================================================

// --- Type Checker (from type-checker.ts) ---

const tsLibDir = path.dirname(require.resolve("typescript/lib/lib.es2022.d.ts"));

const LIB_NAMES = [
  "lib.es5.d.ts", "lib.es2015.d.ts", "lib.es2015.promise.d.ts",
  "lib.es2015.iterable.d.ts", "lib.es2015.collection.d.ts",
  "lib.es2015.symbol.d.ts", "lib.es2015.symbol.wellknown.d.ts",
  "lib.es2015.core.d.ts", "lib.es2015.generator.d.ts",
  "lib.es2015.proxy.d.ts", "lib.es2015.reflect.d.ts",
  "lib.es2016.d.ts", "lib.es2016.array.include.d.ts",
  "lib.es2017.d.ts", "lib.es2017.string.d.ts", "lib.es2017.object.d.ts",
  "lib.es2018.d.ts", "lib.es2018.asyncgenerator.d.ts",
  "lib.es2018.asynciterable.d.ts", "lib.es2018.promise.d.ts",
  "lib.es2018.regexp.d.ts",
  "lib.es2019.d.ts", "lib.es2019.array.d.ts", "lib.es2019.object.d.ts",
  "lib.es2019.string.d.ts",
  "lib.es2020.d.ts", "lib.es2020.string.d.ts", "lib.es2020.promise.d.ts",
  "lib.es2020.bigint.d.ts",
  "lib.es2021.d.ts", "lib.es2021.promise.d.ts", "lib.es2021.string.d.ts",
  "lib.es2022.d.ts", "lib.es2022.array.d.ts", "lib.es2022.error.d.ts",
  "lib.es2022.object.d.ts", "lib.es2022.string.d.ts",
];

const libFiles = new Map();
for (const name of LIB_NAMES) {
  const filePath = path.join(tsLibDir, name);
  if (fs.existsSync(filePath)) {
    libFiles.set(name, ts.createSourceFile(name, fs.readFileSync(filePath, "utf-8"), ts.ScriptTarget.ESNext, true));
  }
}

const TYPE_DEFS = `
declare const tools: {
  read(params: { path: string; offset?: number; limit?: number }): Promise<string>;
  bash(params: { command: string; timeout?: number }): Promise<{ output: string; exitCode: number }>;
  write(params: { path: string; content: string }): Promise<void>;
  search_tools(params: { query: string }): Promise<string>;
  mcp(params: { tool: string; args?: Record<string, unknown>; server?: string }): Promise<unknown>;
  progress(message: string): void;
};
declare function print(...args: any[]): void;
declare const YAML: { parse(yaml: string): any; stringify(value: any): string; };
`;

const TYPE_DEF_LINE_COUNT = TYPE_DEFS.split("\n").length;

function typeCheck(userCode) {
  const fullSource = TYPE_DEFS + "\n(async () => {\n" + userCode + "\n})();\n";
  const fileName = "codemode.ts";
  const sourceFile = ts.createSourceFile(fileName, fullSource, ts.ScriptTarget.ESNext, true);
  const host = {
    getSourceFile: (name) => name === fileName ? sourceFile : libFiles.get(name),
    getDefaultLibFileName: () => "lib.es5.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === fileName || libFiles.has(f),
    readFile: () => undefined,
  };
  const program = ts.createProgram([fileName, ...libFiles.keys()], {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    strict: true, noEmit: true, skipLibCheck: true, types: [],
  }, host);
  const diags = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
  return diags.map(d => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start !== undefined) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      return { line: Math.max(1, pos.line - TYPE_DEF_LINE_COUNT), col: pos.character + 1, message: msg };
    }
    return { line: 0, col: 0, message: msg };
  });
}

// --- Sandbox (from sandbox.ts) ---

async function executeCode(tsCode, bindings) {
  // Type check
  const errors = typeCheck(tsCode);
  if (errors.length > 0) return { success: false, errors, logs: [], returnValue: undefined };

  // Strip types
  const wrappedTs = `(async () => {\n${tsCode}\n})`;
  let jsCode;
  try {
    const result = esbuild.transformSync(wrappedTs, { loader: "ts", target: "esnext" });
    jsCode = result.code.trim().replace(/;$/, "");
  } catch (e) {
    return { success: false, errors: [{ line: 0, col: 0, message: e.message }], logs: [], returnValue: undefined };
  }

  // Execute in vm
  const logs = [];
  const captureLog = (...args) => logs.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
  const context = vm.createContext({
    tools: bindings, print: captureLog,
    console: { log: captureLog, warn: captureLog, error: captureLog },
    Promise, setTimeout, clearTimeout, JSON, Array, Object, Map, Set, Math, Date, RegExp, Error,
    TypeError, RangeError, Number, String, Boolean, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    undefined, NaN, Infinity, URL, URLSearchParams, YAML,
  });

  try {
    const fn = vm.runInContext(jsCode, context, { timeout: 10_000, filename: "codemode.js" });
    const returnValue = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), 10_000)),
    ]);
    return { success: true, errors: [], logs, returnValue };
  } catch (e) {
    return { success: false, errors: [{ line: 0, col: 0, message: e.message }], logs, returnValue: undefined };
  }
}

// --- Mock tool bindings ---

const mockBindings = {
  async read(params) {
    return fs.readFileSync(path.resolve(process.cwd(), params.path), "utf-8");
  },
  async bash(params) {
    try {
      const output = execSync(params.command, { encoding: "utf-8", cwd: process.cwd(), timeout: 10000 });
      return { output, exitCode: 0 };
    } catch (e) {
      return { output: e.stderr || e.message, exitCode: e.status || 1 };
    }
  },
  async write(params) {
    const p = path.resolve(process.cwd(), params.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, params.content);
  },
  async search_tools() { return "No MCP tools available in test mode."; },
  async mcp() { throw new Error("MCP not available in test mode"); },
  progress(msg) { console.log(`[progress] ${msg}`); },
};

// ============================================================
// Tests
// ============================================================

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (e) {
    failed++;
    console.log(`  ✗ THREW: ${e.message}`);
  }
}

(async () => {
  // --- Type checker tests ---

  await test("Type checker: valid code passes", async () => {
    const errors = typeCheck(`const x = await tools.read({ path: "foo.ts" });\nprint(x.length);`);
    assert(errors.length === 0, "no errors");
  });

  await test("Type checker: wrong param type", async () => {
    const errors = typeCheck(`await tools.read({ path: 42 });`);
    assert(errors.length > 0, "has errors");
    assert(errors.some(e => e.message.includes("not assignable")), "type mismatch error");
  });

  await test("Type checker: missing required param", async () => {
    const errors = typeCheck(`await tools.read({});`);
    assert(errors.length > 0, "has errors");
    assert(errors.some(e => e.message.includes("path")), "mentions 'path'");
  });

  await test("Type checker: non-existent tool", async () => {
    const errors = typeCheck(`await tools.delete({ path: "foo" });`);
    assert(errors.length > 0, "has errors");
    assert(errors.some(e => e.message.includes("does not exist")), "property not found");
  });

  await test("Type checker: wrong return type usage", async () => {
    const errors = typeCheck(`const x: number = await tools.read({ path: "foo" });`);
    assert(errors.length > 0, "has errors");
    assert(errors.some(e => e.message.includes("not assignable")), "type mismatch");
  });

  await test("Type checker: syntax error", async () => {
    const errors = typeCheck(`const x: = 42;`);
    assert(errors.length > 0, "has errors");
  });

  await test("Type checker: complex valid code", async () => {
    const errors = typeCheck(`
const files = await tools.bash({ command: "ls" });
const paths = files.output.split("\\n").filter(p => p.trim());
for (const p of paths) {
  const content = await tools.read({ path: p });
  if (content.includes("TODO")) print(p);
}
`);
    assert(errors.length === 0, "no errors");
  });

  await test("Type checker: bash result used correctly", async () => {
    const errors = typeCheck(`
const r = await tools.bash({ command: "ls" });
const lines: number = r.output.split("\\n").length;
const code: number = r.exitCode;
`);
    assert(errors.length === 0, "no errors");
  });

  await test("Type checker: bash result used incorrectly", async () => {
    const errors = typeCheck(`const r = await tools.bash({ command: "ls" });\nr.output.toFixed(2);`);
    assert(errors.length > 0, "has errors");
    assert(errors.some(e => e.message.includes("toFixed")), "wrong method on string");
  });

  // --- Full pipeline tests ---

  await test("Pipeline: valid code executes", async () => {
    const result = await executeCode(
      `const pkg = await tools.read({ path: "package.json" });\nconst parsed = JSON.parse(pkg);\nreturn parsed.name;`,
      mockBindings
    );
    assert(result.success, "success");
    assert(result.returnValue === "pi-codemode", `returned "${result.returnValue}"`);
  });

  await test("Pipeline: type error blocks execution", async () => {
    const result = await executeCode(
      `await tools.read({ path: 42 });`,
      mockBindings
    );
    assert(!result.success, "failed");
    assert(result.errors.length > 0, "has type errors");
  });

  await test("Pipeline: print captures output", async () => {
    const result = await executeCode(
      `print("hello"); print("world"); return 42;`,
      mockBindings
    );
    assert(result.success, "success");
    assert(result.logs.length === 2, `${result.logs.length} log lines`);
    assert(result.logs[0] === "hello", "first log");
    assert(result.logs[1] === "world", "second log");
    assert(result.returnValue === 42, "return value");
  });

  await test("Pipeline: multi-tool composition", async () => {
    const result = await executeCode(`
const r = await tools.bash({ command: "ls ${process.cwd()}" });
const files = r.output.split("\\n").filter(f => f.endsWith(".json"));
print("JSON files:", files.length);
return files;
`, mockBindings);
    assert(result.success, "success");
    assert(Array.isArray(result.returnValue), "returns array");
    assert(result.returnValue.includes("package.json"), "found package.json");
  });

  await test("Pipeline: runtime error captured", async () => {
    const result = await executeCode(
      `const x = JSON.parse("not json");`,
      mockBindings
    );
    assert(!result.success, "failed");
    assert(result.errors.length > 0, "has runtime errors");
  });

  await test("Pipeline: write + read roundtrip", async () => {
    const tmpFile = `/tmp/pi-codemode-test-${Date.now()}.txt`;
    const result = await executeCode(`
await tools.write({ path: "${tmpFile}", content: "hello from codemode" });
const content = await tools.read({ path: "${tmpFile}" });
return content.trim();
`, mockBindings);
    assert(result.success, "success");
    assert(result.returnValue === "hello from codemode", `got "${result.returnValue}"`);
    // Cleanup
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  await test("Pipeline: YAML parse and stringify", async () => {
    const result = await executeCode(`
const yamlStr = "name: test\\nversion: 1\\nitems:\\n  - a\\n  - b";
const parsed = YAML.parse(yamlStr);
const back = YAML.stringify(parsed);
return { parsed, roundtrip: back };
`, mockBindings);
    assert(result.success, "success");
    const val = result.returnValue;
    assert(val.parsed.name === "test", `name: ${val.parsed.name}`);
    assert(val.parsed.version === 1, `version: ${val.parsed.version}`);
    assert(Array.isArray(val.parsed.items) && val.parsed.items.length === 2, "items array");
    assert(typeof val.roundtrip === "string", "roundtrip is string");
  });
  // --- Benchmark ---
  console.log("\nBenchmark:");
  const benchCode = `const x = await tools.read({ path: "package.json" });\nreturn x.length;`;

  // Type check only
  const tcStart = performance.now();
  for (let i = 0; i < 100; i++) typeCheck(benchCode);
  const tcMs = performance.now() - tcStart;
  console.log(`  Type check: 100 runs in ${tcMs.toFixed(0)}ms (${(tcMs/100).toFixed(1)}ms/check)`);

  // Full pipeline (without actual tool calls)
  const pStart = performance.now();
  for (let i = 0; i < 50; i++) {
    await executeCode(`print(42); return 1;`, mockBindings);
  }
  const pMs = performance.now() - pStart;
  console.log(`  Full pipeline (trivial): 50 runs in ${pMs.toFixed(0)}ms (${(pMs/50).toFixed(1)}ms/run)`);

  // --- Summary ---
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();