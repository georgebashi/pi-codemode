
// Quick integration test: use esbuild to load the real type-checker.ts + type-generator.ts

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Bundle the type-checker and type-generator together as CJS
const typeCheckerSrc = fs.readFileSync(path.join(__dirname, "../src/type-checker.ts"), "utf-8");
const typeGeneratorSrc = fs.readFileSync(path.join(__dirname, "../src/type-generator.ts"), "utf-8");

// Strip types from each module
function stripTypes(src) {
  return esbuild.transformSync(src, { loader: "ts", target: "esnext", format: "cjs" }).code;
}

// Write to temp files and require them
const tmpDir = path.join(__dirname, ".tmp");
fs.mkdirSync(tmpDir, { recursive: true });

fs.writeFileSync(path.join(tmpDir, "type-checker.js"), stripTypes(typeCheckerSrc));
fs.writeFileSync(path.join(tmpDir, "type-generator.js"), stripTypes(typeGeneratorSrc));

const typeChecker = require(path.join(tmpDir, "type-checker.js"));
const typeGenerator = require(path.join(tmpDir, "type-generator.js"));

// Init
typeChecker.initTypeChecker();

// Generate type defs
const builtinTypeDefs = typeGenerator.generateBuiltinTypeDefs();
const mcpTypeDefs = typeGenerator.generateMcpServerTypeDefs([]);
const typeDefs = builtinTypeDefs + "\n" + mcpTypeDefs;

console.log("Type defs:", typeDefs.length, "chars");

// Type check tests
let passed = 0, failed = 0;
function test(name, code) {
  const result = typeChecker.typeCheck(code, typeDefs);
  if (result.errors.length === 0) {
    passed++;
    console.log("  \u2713", name);
  } else {
    failed++;
    console.log("  \u2717", name);
    for (const e of result.errors.slice(0, 3)) {
      console.log("    L" + e.line + ":", e.message.substring(0, 120));
    }
    if (result.errors.length > 3) console.log("    ... and", result.errors.length - 3, "more");
  }
}

console.log("\nType checking with real zx imports:");

test("trivial code", "const x = 1;");
test("$ template literal", "const r = await $`echo hello`; const s: string = r.stdout;");
test("ProcessOutput properties", "const r = await $`ls`; const ok: boolean = r.ok; const d: number = r.duration;");
test("nothrow and quiet", "const r = await nothrow($`false`); await quiet($`npm install`);");
test("path module", 'const ext: string = path.extname("foo.ts"); const dir: string = path.dirname("/a/b");');
test("os module", 'const home: string = os.homedir(); const plat: string = os.platform();');
test("Buffer type", "const r = await $`ls`; const buf: Buffer = r.buffer();");
test("glob, which, quote, sleep", 'const files: string[] = await glob("*.ts"); const q: string = quote("hello");');
test("cd, within", 'cd("/tmp"); within(() => { cd("/var"); });');
test("fs module (fs-extra)", 'fs.readFileSync("foo.txt", "utf-8"); fs.ensureDir("/tmp/test");');
test("tools + zx together", 'const pkg = await tools.read({ path: "package.json" }); const r = await $`echo hello`; print(pkg.length, r.stdout);');
test("ProcessPromise .json()", "const j = await $`cat package.json`.json(); const t: string = await $`ls`.text();");

// Negative tests: verify type errors ARE caught
function testError(name, code, expectedSubstring) {
  const result = typeChecker.typeCheck(code, typeDefs);
  if (result.errors.length > 0 && result.errors.some(e => e.message.includes(expectedSubstring))) {
    passed++;
    console.log("  \u2713", name);
  } else {
    failed++;
    if (result.errors.length === 0) {
      console.log("  \u2717", name, "(expected error but got none)");
    } else {
      console.log("  \u2717", name, "(error didn't match '" + expectedSubstring + "')");
      for (const e of result.errors.slice(0, 2)) console.log("    ", e.message.substring(0, 120));
    }
  }
}

console.log("\nNegative tests (should produce errors):");
testError("$ stdout is not number", "const n: number = (await $`ls`).stdout;", "not assignable to type 'number'");
testError("path.extname returns string not number", 'const n: number = path.extname("foo.ts");', "not assignable to type 'number'");
testError("fs.ensureDir needs string arg", 'fs.ensureDir(123);', "Argument of type 'number'");

// Benchmark
const benchCode = "const r = await $`echo hello`; const s: string = r.stdout;";
typeChecker.typeCheck(benchCode, typeDefs); // warmup
const start = performance.now();
for (let i = 0; i < 100; i++) typeChecker.typeCheck(benchCode, typeDefs);
const elapsed = performance.now() - start;
console.log("\nBenchmark: 100 checks in " + elapsed.toFixed(0) + "ms (" + (elapsed/100).toFixed(1) + "ms/check)");

console.log("\n" + "=".repeat(40));
console.log("Results: " + passed + " passed, " + failed + " failed");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
