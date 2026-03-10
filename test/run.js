// test/run.js — Standalone test for type-checker + sandbox core logic.
// Tests the pipeline without needing pi's runtime.

const ts = require("typescript");
const esbuild = require("esbuild");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const zx = require("zx");

// Suppress zx verbose logging
zx.$.verbose = false;

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

// Simplified type defs for testing (no $ — that's a runtime-only binding)
const TYPE_DEFS = [
  "declare const tools: {",
  "  read(params: { path: string; offset?: number; limit?: number }): Promise<string>;",
  "  write(params: { path: string; content: string }): Promise<void>;",
  "  search_tools(params: { query: string }): Promise<string>;",
  "  progress(message: string): void;",
  "};",
  "declare function print(...args: any[]): void;",
  "declare const YAML: { parse(yaml: string): any; stringify(value: any): string; };",
].join("\n");

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

// --- Truncation (from sandbox.ts) ---

const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024;

const { randomBytes } = require("crypto");
const { tmpdir } = require("os");

function getTempFilePath() {
  const id = randomBytes(8).toString("hex");
  return path.join(tmpdir(), "pi-codemode-" + id + ".log");
}

function sanitizeOutput(str) {
  return Array.from(str)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

function truncateStringToBytesFromEnd(str, maxBytes) {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.slice(start).toString("utf-8");
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

function truncateFromTail(rawText) {
  const text = sanitizeOutput(rawText);
  const totalBytes = Buffer.byteLength(text, "utf-8");
  const lines = text.split("\n");
  const totalLines = lines.length;

  if (totalLines <= MAX_OUTPUT_LINES && totalBytes <= MAX_OUTPUT_BYTES) {
    return { text, wasTruncated: false };
  }

  const fullOutputPath = getTempFilePath();
  try {
    fs.writeFileSync(fullOutputPath, text, "utf-8");
  } catch {}

  const kept = [];
  let keptBytes = 0;

  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_OUTPUT_LINES; i--) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0);
    if (keptBytes + lineBytes > MAX_OUTPUT_BYTES) {
      if (kept.length === 0) {
        const partialLine = truncateStringToBytesFromEnd(lines[i], MAX_OUTPUT_BYTES);
        kept.unshift(partialLine);
        keptBytes = Buffer.byteLength(partialLine, "utf-8");
      }
      break;
    }
    kept.unshift(lines[i]);
    keptBytes += lineBytes;
  }

  const startLine = totalLines - kept.length + 1;
  const endLine = totalLines;
  let notice;
  if (kept.length === 1 && kept[0] !== lines[totalLines - 1]) {
    const keptSize = formatSize(keptBytes);
    const fullSize = formatSize(totalBytes);
    notice = "\n\n[Showing last " + keptSize + " of line " + endLine + " (" + fullSize + " total). Full output: " + fullOutputPath + "]";
  } else {
    notice = "\n\n[Showing lines " + startLine + "-" + endLine + " of " + totalLines + ". Full output: " + fullOutputPath + "]";
  }

  return {
    text: kept.join("\n") + notice,
    wasTruncated: true,
    fullOutputPath,
  };
}

function truncateProcessOutput(output) {
  const rawStdout = output.stdout;
  const rawStderr = output.stderr;
  const rawStdall = output.stdall;

  const truncStdout = truncateFromTail(rawStdout);
  const truncStderr = truncateFromTail(rawStderr);
  const truncStdall = truncateFromTail(rawStdall);

  if (!truncStdout.wasTruncated && !truncStderr.wasTruncated) {
    if (truncStdout.text === rawStdout && truncStderr.text === rawStderr) {
      return output;
    }
  }

  return new Proxy(output, {
    get(target, prop, receiver) {
      if (prop === 'stdout') return truncStdout.text;
      if (prop === 'stderr') return truncStderr.text;
      if (prop === 'stdall') return truncStdall.text;
      return Reflect.get(target, prop, receiver);
    }
  });
}

function createTruncating$(cwd) {
  const base$ = zx.$({ cwd });
  const wrapped = function(pieces, ...args) {
    const proc = base$(pieces, ...args);
    const origThen = proc.then.bind(proc);
    proc.then = function(onFulfill, onReject) {
      return origThen(
        (output) => {
          const truncated = truncateProcessOutput(output);
          return onFulfill ? onFulfill(truncated) : truncated;
        },
        (err) => {
          if (err instanceof zx.ProcessOutput) err = truncateProcessOutput(err);
          if (onReject) return onReject(err);
          throw err;
        }
      );
    };
    return proc;
  };
  return Object.assign(wrapped, base$);
}

// --- Sandbox (from sandbox.ts) ---

async function executeCode(tsCode, bindings, { skipTypeCheck = false } = {}) {
  if (!skipTypeCheck) {
    const errors = typeCheck(tsCode);
    if (errors.length > 0) return { success: false, errors, logs: [], returnValue: undefined };
  }

  const wrappedTs = "(async () => {\n" + tsCode + "\n})";
  let jsCode;
  try {
    const result = esbuild.transformSync(wrappedTs, { loader: "ts", target: "esnext" });
    jsCode = result.code.trim().replace(/;$/, "");
  } catch (e) {
    return { success: false, errors: [{ line: 0, col: 0, message: e.message }], logs: [], returnValue: undefined };
  }

  const logs = [];
  const captureLog = (...args) => logs.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
  const context = vm.createContext({
    tools: bindings, print: captureLog,
    console: { log: captureLog, warn: captureLog, error: captureLog },
    Promise, setTimeout, clearTimeout, JSON, Array, Object, Map, Set, Math, Date, RegExp, Error,
    TypeError, RangeError, Number, String, Boolean, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    undefined, NaN, Infinity, URL, URLSearchParams, YAML,
    // zx shell utilities — uses truncating wrapper
    $: createTruncating$(process.cwd()),
    cd: zx.cd,
    nothrow: zx.nothrow,
    quiet: zx.quiet,
    path,
    fs: require("fs-extra"),
    os: require("os"),
    ProcessOutput: zx.ProcessOutput,
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
  async write(params) {
    const p = path.resolve(process.cwd(), params.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, params.content);
  },
  async search_tools() { return "No MCP tools available in test mode."; },
  progress(msg) { console.log("[progress] " + msg); },
};

// ============================================================
// Tests
// ============================================================

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log("  \u2713 " + msg);
  } else {
    failed++;
    console.log("  \u2717 " + msg);
  }
}

async function test(name, fn) {
  console.log("\n" + name);
  try {
    await fn();
  } catch (e) {
    failed++;
    console.log("  \u2717 THREW: " + e.message);
  }
}

(async () => {
  // --- Type checker tests ---

  await test("Type checker: valid code passes", async () => {
    const errors = typeCheck('const x = await tools.read({ path: "foo.ts" });\nprint(x.length);');
    assert(errors.length === 0, "no errors (" + errors.map(e => e.message).join(", ") + ")");
  });

  await test("Type checker: wrong param type", async () => {
    const errors = typeCheck('await tools.read({ path: 42 });');
    assert(errors.length > 0, "has errors");
    assert(errors.some(e => e.message.includes("not assignable")), "type mismatch error");
  });

  await test("Type checker: missing required param", async () => {
    const errors = typeCheck('await tools.read({});');
    assert(errors.length > 0, "has errors");
    assert(errors.some(e => e.message.includes("path")), "mentions 'path'");
  });

  await test("Type checker: non-existent tool", async () => {
    const errors = typeCheck('await tools.delete({ path: "foo" });');
    assert(errors.length > 0, "has errors");
    assert(errors.some(e => e.message.includes("does not exist")), "property not found");
  });

  await test("Type checker: wrong return type usage", async () => {
    const errors = typeCheck('const x: number = await tools.read({ path: "foo" });');
    assert(errors.length > 0, "has errors");
    assert(errors.some(e => e.message.includes("not assignable")), "type mismatch");
  });

  await test("Type checker: syntax error", async () => {
    const errors = typeCheck('const x: = 42;');
    assert(errors.length > 0, "has errors");
  });

  // --- Full pipeline tests ---

  await test("Pipeline: valid code executes", async () => {
    const result = await executeCode(
      'const pkg = await tools.read({ path: "package.json" });\nconst parsed = JSON.parse(pkg);\nreturn parsed.name;',
      mockBindings
    );
    assert(result.success, "success (" + result.errors.map(e => e.message).join(", ") + ")");
    assert(result.returnValue === "pi-codemode", 'returned "' + result.returnValue + '"');
  });

  await test("Pipeline: type error blocks execution", async () => {
    const result = await executeCode(
      'await tools.read({ path: 42 });',
      mockBindings
    );
    assert(!result.success, "failed");
    assert(result.errors.length > 0, "has type errors");
  });

  await test("Pipeline: print captures output", async () => {
    const result = await executeCode(
      'print("hello"); print("world"); return 42;',
      mockBindings
    );
    assert(result.success, "success (" + result.errors.map(e => e.message).join(", ") + ")");
    assert(result.logs.length === 2, result.logs.length + " log lines");
    assert(result.logs[0] === "hello", "first log");
    assert(result.logs[1] === "world", "second log");
    assert(result.returnValue === 42, "return value");
  });

  await test("Pipeline: zx $ shell commands (skip type check)", async () => {
    const cwd = process.cwd();
    const result = await executeCode(
      'const r = await $`ls ' + cwd + '`;\nconst files = r.stdout.split("\\n").filter(f => f.endsWith(".json"));\nprint("JSON files:", files.length);\nreturn files;',
      mockBindings,
      { skipTypeCheck: true }
    );
    assert(result.success, "success (" + result.errors.map(e => e.message).join(", ") + ")");
    if (result.success) {
      assert(Array.isArray(result.returnValue), "returns array");
      assert(result.returnValue.includes("package.json"), "found package.json");
    }
  });

  await test("Pipeline: runtime error captured", async () => {
    const result = await executeCode(
      'const x = JSON.parse("not json");',
      mockBindings
    );
    assert(!result.success, "failed");
    assert(result.errors.length > 0, "has runtime errors");
  });

  await test("Pipeline: write + read roundtrip", async () => {
    const tmpFile = "/tmp/pi-codemode-test-" + Date.now() + ".txt";
    const result = await executeCode(
      'await tools.write({ path: "' + tmpFile + '", content: "hello from codemode" });\n' +
      'const content = await tools.read({ path: "' + tmpFile + '" });\n' +
      'return content.trim();',
      mockBindings
    );
    assert(result.success, "success (" + result.errors.map(e => e.message).join(", ") + ")");
    assert(result.returnValue === "hello from codemode", 'got "' + result.returnValue + '"');
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  await test("Pipeline: YAML parse and stringify", async () => {
    const result = await executeCode(
      'const yamlStr = "name: test\\nversion: 1\\nitems:\\n  - a\\n  - b";\n' +
      'const parsed = YAML.parse(yamlStr);\n' +
      'const back = YAML.stringify(parsed);\n' +
      'return { parsed, roundtrip: back };',
      mockBindings
    );
    assert(result.success, "success (" + result.errors.map(e => e.message).join(", ") + ")");
    if (result.success) {
      const val = result.returnValue;
      assert(val.parsed.name === "test", "name: " + val.parsed.name);
      assert(val.parsed.version === 1, "version: " + val.parsed.version);
      assert(Array.isArray(val.parsed.items) && val.parsed.items.length === 2, "items array");
      assert(typeof val.roundtrip === "string", "roundtrip is string");
    }
  });

  // --- Truncation tests ---

  await test("Truncation: truncateFromTail keeps small output intact", async () => {
    const small = "line1\nline2\nline3";
    const result = truncateFromTail(small);
    assert(!result.wasTruncated, "not truncated");
    assert(result.text === small, "text unchanged");
    assert(!result.fullOutputPath, "no temp file");
  });

  await test("Truncation: truncateFromTail truncates >2000 lines", async () => {
    const lines = [];
    for (let i = 0; i < 3000; i++) lines.push("line " + i);
    const big = lines.join("\n");
    const result = truncateFromTail(big);
    assert(result.wasTruncated, "was truncated");
    assert(result.fullOutputPath, "has temp file path");
    const resultLines = result.text.split("\n");
    assert(resultLines.length <= 2003, "truncated to ~2000 lines (got " + resultLines.length + ")");
    assert(result.text.includes("[Showing lines"), "has truncation notice");
    assert(result.text.includes("of 3000"), "mentions total lines");
    assert(result.text.includes("line 2999"), "has last line");
    assert(!result.text.includes("line 0\n"), "dropped first line");
    // Verify temp file exists and has full output
    assert(fs.existsSync(result.fullOutputPath), "temp file exists");
    assert(result.text.includes(result.fullOutputPath), "notice includes temp file path");
    try { fs.unlinkSync(result.fullOutputPath); } catch {}
  });

  await test("Truncation: truncateFromTail truncates by bytes", async () => {
    const lines = [];
    for (let i = 0; i < 100; i++) lines.push("x".repeat(1024) + " line" + i);
    const big = lines.join("\n");
    const result = truncateFromTail(big);
    assert(result.wasTruncated, "was truncated");
    const resultBytes = Buffer.byteLength(result.text, "utf-8");
    assert(resultBytes < 55000, "under byte limit (got " + resultBytes + " bytes)");
    assert(result.text.includes("[Showing lines"), "has truncation notice");
    assert(result.text.includes("line99"), "has last line");
    try { fs.unlinkSync(result.fullOutputPath); } catch {}
  });

  await test("Truncation: single line > 50KB keeps tail bytes", async () => {
    // Create a single line that exceeds 50KB
    const bigLine = "x".repeat(80 * 1024); // 80KB single line
    const result = truncateFromTail(bigLine);
    assert(result.wasTruncated, "was truncated");
    const resultBytes = Buffer.byteLength(result.text.split("\n")[0], "utf-8");
    assert(resultBytes > 0, "kept some bytes (got " + resultBytes + ")");
    assert(resultBytes <= MAX_OUTPUT_BYTES, "within byte limit");
    assert(result.text.includes("Showing last"), "has partial-line notice");
    try { fs.unlinkSync(result.fullOutputPath); } catch {}
  });

  await test("Truncation: sanitizes control characters", async () => {
    const dirty = "hello\x00world\x01foo\tbar\nnewline";
    const result = truncateFromTail(dirty);
    assert(!result.text.includes("\x00"), "null byte removed");
    assert(!result.text.includes("\x01"), "SOH removed");
    assert(result.text.includes("\t"), "tab preserved");
    assert(result.text.includes("\n"), "newline preserved");
    assert(result.text.includes("hello"), "text preserved");
    assert(result.text.includes("bar"), "text after tab preserved");
  });

  await test("Truncation: $ output is truncated with temp file (skip type check)", async () => {
    // Generate >2000 lines via seq command
    const result = await executeCode(
      'const r = await $`seq 1 5000`;\n' +
      'const hasNotice = r.stdout.includes("[Showing lines");\n' +
      'const hasTempPath = r.stdout.includes("Full output:");\n' +
      'return { lineCount: r.stdout.split("\\n").length, hasNotice, hasTempPath };',
      mockBindings,
      { skipTypeCheck: true }
    );
    assert(result.success, "success (" + result.errors.map(e => e.message).join(", ") + ")");
    if (result.success) {
      const val = result.returnValue;
      assert(val.hasNotice, "stdout has truncation notice");
      assert(val.hasTempPath, "stdout has temp file path");
      assert(val.lineCount <= 2010, "line count reduced (got " + val.lineCount + ")");
      assert(val.lineCount >= 1900, "still has ~2000 lines (got " + val.lineCount + ")");
    }
  });

  // --- Benchmark ---
  console.log("\nBenchmark:");
  const benchCode = 'const x = await tools.read({ path: "package.json" });\nreturn x.length;';

  const tcStart = performance.now();
  for (let i = 0; i < 100; i++) typeCheck(benchCode);
  const tcMs = performance.now() - tcStart;
  console.log("  Type check: 100 runs in " + tcMs.toFixed(0) + "ms (" + (tcMs/100).toFixed(1) + "ms/check)");

  const pStart = performance.now();
  for (let i = 0; i < 50; i++) {
    await executeCode('print(42); return 1;', mockBindings);
  }
  const pMs = performance.now() - pStart;
  console.log("  Full pipeline (trivial): 50 runs in " + pMs.toFixed(0) + "ms (" + (pMs/50).toFixed(1) + "ms/run)");

  // --- Summary ---
  console.log("\n" + "=".repeat(40));
  console.log("Results: " + passed + " passed, " + failed + " failed");
  process.exit(failed > 0 ? 1 : 0);
})();
