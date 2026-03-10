// sandbox.ts — Execute LLM-generated code in a Node.js vm context.
//
// Pipeline: type-check → esbuild strip types → vm.runInContext
// The vm provides a clean namespace with only our tool bindings and safe globals.

import vm from "node:vm";
import { transformSync } from "esbuild";
import { typeCheck, type TypeCheckError } from "./type-checker.js";
import type { ToolBindings } from "./tool-bindings.js";

export interface ExecutionResult {
  success: boolean;
  /** Type errors or runtime errors */
  errors: TypeCheckError[];
  /** 'type' for type-check failures, 'runtime' for execution errors */
  errorKind?: 'type' | 'runtime';
  /** Captured console.log / print output */
  logs: string[];
  /** The return value of the code (if any) */
  returnValue: unknown;
  /** Execution time in ms */
  elapsedMs: number;
}

export interface SandboxOptions {
  /** Max execution time in ms (default: 120_000 = 2 minutes) */
  timeout?: number;
  /** Max output size in bytes (default: 50KB) */
  maxOutputSize?: number;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 50 * 1024;

/**
 * Execute TypeScript code in a sandboxed vm context with tool bindings.
 *
 * @param tsCode - The TypeScript code body (no function wrapper needed)
 * @param typeDefs - TypeScript declarations for the tool API
 * @param bindings - Runtime tool functions
 * @param options - Timeout and output limits
 */
export async function executeCode(
  tsCode: string,
  typeDefs: string,
  bindings: ToolBindings,
  options?: SandboxOptions
): Promise<ExecutionResult> {
  const start = performance.now();
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options?.maxOutputSize ?? DEFAULT_MAX_OUTPUT;

  // Step 1: Type-check
  const checkResult = typeCheck(tsCode, typeDefs);
  if (checkResult.errors.length > 0) {
    return {
      success: false,
      errorKind: 'type',
      errors: checkResult.errors,
      logs: [],
      returnValue: undefined,
      elapsedMs: performance.now() - start,
    };
  }

  // Step 2: Strip types via esbuild
  const wrappedTs = `(async () => {\n${tsCode}\n})`;
  let jsCode: string;
  try {
    const result = transformSync(wrappedTs, {
      loader: "ts",
      target: "esnext",
    });
    // esbuild may add a trailing semicolon after the arrow function
    jsCode = result.code.trim().replace(/;$/, "");
  } catch (e: any) {
    return {
      success: false,
      errorKind: 'type',
      errors: [
        {
          line: 0,
          col: 0,
          message: `esbuild transform error: ${e.message}`,
        },
      ],
      logs: [],
      returnValue: undefined,
      elapsedMs: performance.now() - start,
    };
  }

  // Step 3: Create vm context with bindings and safe globals
  const logs: string[] = [];
  let totalLogSize = 0;

  const captureLog = (...args: unknown[]) => {
    const line = args
      .map((a) =>
        typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)
      )
      .join(" ");
    totalLogSize += line.length;
    if (totalLogSize <= maxOutput) {
      logs.push(line);
    } else if (logs[logs.length - 1] !== "[output truncated]") {
      logs.push("[output truncated]");
    }
  };

  const context = vm.createContext({
    // Tool bindings
    tools: bindings,
    print: captureLog,

    // Console (captured)
    console: {
      log: captureLog,
      warn: captureLog,
      error: captureLog,
      info: captureLog,
    },

    // Safe globals
    Promise,
    setTimeout,
    clearTimeout,
    JSON,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Math,
    Date,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    Number,
    String,
    Boolean,
    Symbol,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    undefined,
    NaN,
    Infinity,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    queueMicrotask,
    atob,
    btoa,
  });

  // Step 4: Execute in vm
  try {
    // Compile and get the async function
    const fn = vm.runInContext(jsCode, context, {
      timeout,
      filename: "codemode.js",
    });

    // Execute the async function (vm timeout doesn't cover async,
    // so we also race against a timeout promise)
    const returnValue = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Execution timed out after ${timeout}ms`)),
          timeout
        )
      ),
    ]);

    return {
      success: true,
      errors: [],
      logs,
      returnValue,
      elapsedMs: performance.now() - start,
    };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    // Try to extract line number from stack trace
    const stackMatch = message.match(/codemode\.js:(\d+)/);
    const line = stackMatch ? parseInt(stackMatch[1], 10) - 1 : 0; // -1 for wrapper

    return {
      success: false,
      errorKind: 'runtime',
      errors: [{ line: Math.max(1, line), col: 0, message }],
      logs, // Include any logs captured before the error
      returnValue: undefined,
      elapsedMs: performance.now() - start,
    };
  }
}