// pi-tool-proxy.ts — Monkeypatch ExtensionRunner to enable calling pi tools from the sandbox.
//
// Pi's ExtensionAPI doesn't expose a way to call other registered tools by name.
// We work around this by patching ExtensionRunner.prototype.createContext to capture
// a reference to the runner instance. The runner has getToolDefinition() which returns
// ToolDefinition objects with execute() methods, and getAllRegisteredTools() for discovery.
//
// This gives the sandbox the ability to call any extension-registered tool
// (list_sessions, read_session, subagent, save_memory, web_search, etc.)
// — everything except the 7 core tools (read, bash, edit, write, grep, find, ls)
// which are already handled by code mode's own bindings.

import { ExtensionRunner } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition, ToolInfo, ExtensionContext } from "@mariozechner/pi-coding-agent";

/** Captured runner reference — set by the monkeypatched createContext(). */
let _capturedRunner: ExtensionRunner | undefined;

/** Whether the monkeypatch has been applied. */
let _patched = false;

/**
 * Apply the monkeypatch to ExtensionRunner.prototype.createContext.
 * Safe to call multiple times — only patches once.
 *
 * Must be called at module load time (extension factory), before any session starts.
 */
export function patchExtensionRunner(): void {
  if (_patched) return;
  _patched = true;

  const origCreateContext = ExtensionRunner.prototype.createContext;
  ExtensionRunner.prototype.createContext = function (this: InstanceType<typeof ExtensionRunner>) {
    _capturedRunner = this;
    return origCreateContext.call(this);
  };
}

/** Tool names that code mode handles directly (not proxied through pi tools). */
const CODEMODE_HANDLED_TOOLS = new Set([
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "execute_tools",  // our own tool
  "mcp",            // handled via MCP client
]);

export interface PiToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;  // TypeBox TSchema — JSON Schema compatible
}

/**
 * Get the list of pi tools available for proxying.
 * Returns tools registered by extensions (not core tools handled by code mode).
 * Must be called after session_start (when the runner is captured).
 */
export function getProxiedPiTools(): PiToolInfo[] {
  if (!_capturedRunner) return [];

  const allTools = _capturedRunner.getAllRegisteredTools();
  return allTools
    .filter(rt => !CODEMODE_HANDLED_TOOLS.has(rt.definition.name))
    .map(rt => ({
      name: rt.definition.name,
      description: rt.definition.description,
      inputSchema: rt.definition.parameters,
    }));
}

/**
 * Call a pi tool by name. Uses the captured runner to find the tool definition
 * and execute it with a proper ExtensionContext.
 *
 * @returns The text content of the tool result.
 * @throws If the tool is not found or execution fails.
 */
export async function callPiTool(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (!_capturedRunner) {
    throw new Error(`Cannot call pi tool "${toolName}": runner not available (session not started?)`);
  }

  const toolDef = _capturedRunner.getToolDefinition(toolName);
  if (!toolDef) {
    throw new Error(`Pi tool "${toolName}" not found. Available: ${getProxiedPiTools().map(t => t.name).join(", ")}`);
  }

  const ctx = _capturedRunner.createContext();
  const toolCallId = `codemode-proxy-${Date.now()}`;

  const result = await toolDef.execute(toolCallId, args, signal, undefined, ctx);

  // Extract text content from the result
  const text = result.content
    .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");

  return text;
}
