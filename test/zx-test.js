// test/zx-test.js — Integration test for zx in the sandbox

const vm = require("vm");
const esbuild = require("esbuild");
const zx = require("zx");
const YAML = require("yaml");

// Suppress verbose
zx.$.verbose = false;

async function executeCode(code) {
  const wrappedTs = "(async () => {\n" + code + "\n})";
  const result = esbuild.transformSync(wrappedTs, { loader: "ts", target: "esnext" });
  const jsCode = result.code.trim().replace(/;$/, "");

  const logs = [];
  const captureLog = (...args) => logs.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));

  const context = vm.createContext({
    print: captureLog,
    console: { log: captureLog, warn: captureLog, error: captureLog },
    Promise, setTimeout, clearTimeout, JSON, Array, Object, Map, Set,
    Math, Date, RegExp, Error, TypeError, RangeError, Number, String, Boolean, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    undefined, NaN, Infinity, URL, URLSearchParams, YAML, Buffer,
    // zx
    $: zx.$,
    cd: zx.cd,
    within: zx.within,
    nothrow: zx.nothrow,
    quiet: zx.quiet,
    retry: zx.retry,
    sleep: zx.sleep,
    chalk: zx.chalk,
    which: zx.which,
    quote: zx.quote,
    glob: zx.glob,
    os: zx.os,
    path: zx.path,
    fs: zx.fs,
    ProcessOutput: zx.ProcessOutput,
  });

  try {
    const fn = vm.runInContext(jsCode, context, { timeout: 10000, filename: "codemode.js" });
    const returnValue = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), 10000)),
    ]);
    return { success: true, logs, returnValue };
  } catch (e) {
    return { success: false, logs, error: e.message };
  }
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  \u2713", msg); }
  else { failed++; console.log("  \u2717", msg); }
}

async function test(name, fn) {
  console.log("\n" + name);
  try { await fn(); }
  catch(e) { failed++; console.log("  \u2717 THREW:", e.message); }
}

(async () => {
  await test("zx: basic $ command", async () => {
    const code = "const result = await $\x60echo hello zx\x60;\nreturn result.stdout.trim();";
    const r = await executeCode(code);
    assert(r.success, "success");
    assert(r.returnValue === "hello zx", "got " + JSON.stringify(r.returnValue));
  });

  await test("zx: argument escaping", async () => {
    const code = "const name = \"hello world\";\nconst result = await $\x60echo ${name}\x60;\nreturn result.stdout.trim();";
    const r = await executeCode(code);
    assert(r.success, "success");
    assert(r.returnValue === "hello world", "got " + JSON.stringify(r.returnValue));
  });

  await test("zx: nothrow", async () => {
    const code = "const result = await nothrow($\x60false\x60);\nreturn result.exitCode;";
    const r = await executeCode(code);
    assert(r.success, "success");
    assert(r.returnValue === 1, "exit code: " + r.returnValue);
  });

  await test("zx: path.extname", async () => {
    const r = await executeCode("return path.extname(\"foo.ts\");");
    assert(r.success, "success");
    assert(r.returnValue === ".ts", "got " + JSON.stringify(r.returnValue));
  });

  await test("zx: os.homedir", async () => {
    const r = await executeCode("return os.homedir().length > 0;");
    assert(r.success, "success");
    assert(r.returnValue === true, "has homedir");
  });

  await test("zx: glob", async () => {
    const code = "const files = await glob(\"*.json\");\nreturn files.includes(\"package.json\");";
    const r = await executeCode(code);
    assert(r.success, "success");
    assert(r.returnValue === true, "found package.json");
  });

  await test("zx: which", async () => {
    const code = "const nodePath = await which(\"node\");\nreturn nodePath.length > 0;";
    const r = await executeCode(code);
    assert(r.success, "success");
    assert(r.returnValue === true, "found node");
  });

  await test("zx: quote", async () => {
    const r = await executeCode("const safe = quote(\"hello world\");\nreturn safe;");
    assert(r.success, "success");
    assert(typeof r.returnValue === "string", "is string");
    assert(r.returnValue.includes("hello"), "contains hello");
  });

  await test("zx: chalk", async () => {
    const r = await executeCode("const colored = chalk.red(\"error\");\nreturn typeof colored === \"string\";");
    assert(r.success, "success");
    assert(r.returnValue === true, "chalk works");
  });

  await test("zx: .json()", async () => {
    const code = "const result = await $\x60echo '{\"a\":1}'\x60;\nreturn result.json();";
    const r = await executeCode(code);
    assert(r.success, "success");
    assert(r.returnValue && r.returnValue.a === 1, "got " + JSON.stringify(r.returnValue));
  });

  await test("zx: sleep", async () => {
    const start = Date.now();
    const r = await executeCode("await sleep(100);\nreturn true;");
    const elapsed = Date.now() - start;
    assert(r.success, "success");
    assert(elapsed >= 80 && elapsed < 2000, "took " + elapsed + "ms");
  });

  // Summary
  console.log("\n" + "=".repeat(40));
  console.log("Results: " + passed + " passed, " + failed + " failed");
  process.exit(failed > 0 ? 1 : 0);
})();