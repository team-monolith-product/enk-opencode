import { CodeMode, Tool as CodeModeDef } from "@opencode/codemode"
import { Effect } from "effect"
import z from "zod"

export namespace CodeModeTool {
  export const ID = "execute"
  export const INNER = ["read", "glob", "grep", "apply_patch", "edit", "write", "bash"] as const

  const LIMITS = { timeoutMs: 15 * 60_000, maxToolCalls: 200, maxOutputBytes: 50_000 }

  export interface InnerResult {
    output: string
    title?: string
    metadata?: Record<string, any>
    attachments?: unknown[]
  }

  export interface Inner {
    id: string
    description: string
    parameters: z.ZodType
    run(args: unknown, index: number): Promise<InnerResult>
  }

  export interface Run {
    output: string
    error: boolean
    calls: { tool: string; title?: string; ok: boolean }[]
    attachments: unknown[]
  }

  const GUIDANCE = [
    "Run JavaScript in a confined Code Mode runtime to script several tool calls and compose their results in one step.",
    "Write plain JavaScript and send it exactly as written: no code fence, and no JSON or other wrapper around it.",
    "The tools listed below cannot be called directly: they only work as JavaScript inside this tool. Every other tool you have is a normal tool call: call it directly, never inside this tool.",
    "Call tools through `tools` using only the exact paths and signatures listed below. Every call returns the same text the direct tool would have returned.",
    "Imports, direct filesystem access, and timers are unavailable. All external access goes through `tools`.",
    "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
    "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`, and calls that change the same file one after another.",
    "Use one run for a whole sequence of related steps, such as reading several files and then patching them, instead of one run per step.",
  ].join("\n")

  function freeformKey(schema: Record<string, any>) {
    const props = schema["properties"] as Record<string, any> | undefined
    const required = schema["required"] as string[] | undefined
    if (!props || !required || required.length !== 1) return false
    const only = required[0]
    return Object.keys(props).length === 1 && props[only]?.type === "string"
  }

  function jsonSchema(parameters: z.ZodType) {
    const { $schema: _schema, ...schema } = z.toJSONSchema(parameters) as Record<string, any>
    return schema
  }

  function build(inner: Inner[], record: (call: Run["calls"][number]) => void, attachments: unknown[]) {
    const counter = { value: 0 }
    const tools: Record<string, CodeModeDef.Tool<never>> = {}
    for (const item of inner) {
      const schema = jsonSchema(item.parameters)
      tools[item.id] = CodeModeDef.make({
        description: item.description,
        input: schema as any,
        output: { type: "string" } as any,
        freeform: freeformKey(schema),
        execute: (input: unknown) =>
          Effect.tryPromise({
            try: async () => {
              const index = counter.value++
              try {
                const result = await item.run(input, index)
                if (result.attachments?.length) attachments.push(...result.attachments)
                record({ tool: item.id, title: result.title, ok: true })
                return result.output
              } catch (error) {
                record({ tool: item.id, ok: false })
                throw error
              }
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }),
      })
    }
    return tools
  }

  function indent(text: string) {
    return text
      .trim()
      .split("\n")
      .map((line) => (line ? `  ${line}` : line))
      .join("\n")
  }

  export function description(inner: Inner[]) {
    const runtime = CodeMode.make({ tools: build(inner, () => {}, []), limits: LIMITS })
    const lines = runtime.catalog.map((entry) => `- ${entry.signature}\n${indent(entry.description)}`)
    return `${GUIDANCE}\n\n## Code Mode tools (call only inside this tool)\n\n${lines.join("\n")}`
  }

  export async function run(code: string, inner: Inner[], signal?: AbortSignal): Promise<Run> {
    const calls: Run["calls"] = []
    const attachments: unknown[] = []
    const runtime = CodeMode.make({ tools: build(inner, (call) => calls.push(call), attachments), limits: LIMITS })
    const result = await Effect.runPromise(runtime.execute(code), { signal })
    return { output: format(result), error: !result.ok, calls, attachments }
  }

  export function format(result: CodeMode.Result) {
    const output = result.ok
      ? typeof result.value === "string"
        ? result.value
        : (JSON.stringify(result.value) ?? String(result.value))
      : [
          result.error.message,
          ...(result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint)),
        ]
          .join("\n")
          .trim()
    const warnings =
      result.ok && result.warnings && result.warnings.length > 0
        ? `Warnings:\n${result.warnings.map((item) => `- [${item.kind}] ${item.message}`).join("\n")}`
        : undefined
    const logs = result.logs && result.logs.length > 0 ? `Logs:\n${result.logs.join("\n")}` : undefined
    const value = result.ok && result.value === null && (warnings || logs) ? undefined : output
    return [value, warnings, logs].filter((part) => part !== undefined && part !== "").join("\n\n")
  }
}
