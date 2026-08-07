import type { Part } from "@opencode-ai/sdk/v2/client"

/**
 * Filesystem tools whose failures the model routinely recovers from on its own — a bad line range,
 * a stale edit anchor, a path that moved. Under `hideMinorErrors` their error cards are dropped.
 * Deliberately excludes bash/task/mcp: those failures are the user's business.
 */
const FILE_TOOLS = new Set(["read", "write", "edit", "multiedit", "apply_patch", "glob", "grep", "list"])

/** A file tool that failed — hidden from the timeline when the host asks for it. */
export function minorToolError(part: Part) {
  return part.type === "tool" && part.state.status === "error" && FILE_TOOLS.has(part.tool)
}
