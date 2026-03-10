
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// Read the type-generator.ts source
const src = fs.readFileSync(path.join(__dirname, "../src/type-generator.ts"), "utf-8");

// Strip types with esbuild
const result = esbuild.transformSync(src, { loader: "ts", target: "esnext", format: "cjs" });

// Write to a temp file and require it
const tmpFile = path.join(__dirname, ".type-generator-tmp.js");
fs.writeFileSync(tmpFile, result.code);
try {
  const mod = require(tmpFile);
  const typeDefs = mod.generateBuiltinTypeDefs();
  // Write the typedefs to a file for the test to pick up
  fs.writeFileSync(path.join(__dirname, ".typedefs.txt"), typeDefs);
  console.log("Generated type defs:", typeDefs.length, "chars");
} finally {
  fs.unlinkSync(tmpFile);
}
