import { describe, expect, test } from "bun:test"
import z from "zod"
import { CodeModeTool } from "../../src/tool/codemode"

function fake(log: string[], files: Record<string, string> = {}): CodeModeTool.Inner[] {
  return [
    {
      id: "read",
      description: "Read a file\nlong text",
      parameters: z.object({ filePath: z.string(), offset: z.number().optional() }),
      run: async (args: any) => {
        log.push(`read ${args.filePath}`)
        if (!(args.filePath in files)) throw new Error(`File not found: ${args.filePath}`)
        return { output: files[args.filePath], title: args.filePath }
      },
    },
    {
      id: "apply_patch",
      description: "Apply a patch",
      parameters: z.object({ patchText: z.string() }),
      run: async (args: any) => {
        log.push(`patch ${args.patchText}`)
        return { output: `patched ${args.patchText}`, title: "patch" }
      },
    },
    {
      id: "bash",
      description: "Run a command",
      parameters: z.object({ command: z.string(), timeout: z.number().optional() }),
      run: async (args: any) => ({
        output: "shot",
        attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${args.command}` }],
      }),
    },
  ]
}

describe("CodeModeTool", () => {
  test("description lists each tool signature with its full description", () => {
    const text = CodeModeTool.description(fake([]))
    expect(text).toContain("tools.read(")
    expect(text).toContain("tools.apply_patch(patchText: string)")
    expect(text).toContain("Read a file")
    expect(text).toContain("long text")
  })

  test("runs a sequence of calls in order and returns the program result", async () => {
    const log: string[] = []
    const result = await CodeModeTool.run(
      `
      const a = await tools.read({ filePath: "a.txt" })
      const b = await tools.read({ filePath: "b.txt" })
      await tools.apply_patch("one")
      await tools.apply_patch("two")
      return a + b
      `,
      fake(log, { "a.txt": "A", "b.txt": "B" }),
    )
    expect(result.error).toBe(false)
    expect(result.output).toBe("AB")
    expect(log).toEqual(["read a.txt", "read b.txt", "patch one", "patch two"])
    expect(result.calls.map((call) => call.tool)).toEqual(["read", "read", "apply_patch", "apply_patch"])
    expect(result.calls.every((call) => call.ok)).toBe(true)
  })

  test("a freeform tool accepts the object form too", async () => {
    const log: string[] = []
    const result = await CodeModeTool.run(`return await tools.apply_patch({ patchText: "x" })`, fake(log))
    expect(result.output).toBe("patched x")
  })

  test("a failing tool call can be caught by the program", async () => {
    const result = await CodeModeTool.run(
      `
      try { await tools.read({ filePath: "missing" }) } catch (error) { return "caught: " + error.message }
      `,
      fake([]),
    )
    expect(result.error).toBe(false)
    expect(result.output).toContain("caught:")
    expect(result.output).toContain("File not found: missing")
    expect(result.calls).toEqual([{ tool: "read", title: undefined, ok: false }])
  })

  test("an uncaught failure is reported as an error result", async () => {
    const result = await CodeModeTool.run(`await tools.read({ filePath: "missing" })`, fake([]))
    expect(result.error).toBe(true)
    expect(result.output).toContain("File not found: missing")
  })

  test("a program with a syntax error is reported as an error result", async () => {
    const result = await CodeModeTool.run(`const = 1`, fake([]))
    expect(result.error).toBe(true)
    expect(result.output.length).toBeGreaterThan(0)
  })

  test("attachments returned by inner tools are collected", async () => {
    const result = await CodeModeTool.run(`return await tools.bash({ command: "abc" })`, fake([]))
    expect(result.output).toBe("shot")
    expect(result.attachments).toEqual([{ type: "file", mime: "image/png", url: "data:image/png;base64,abc" }])
  })

  test("calls beyond the limit are refused", async () => {
    const result = await CodeModeTool.run(
      `
      const results = []
      for (let i = 0; i < 205; i++) results.push(await tools.apply_patch("p"))
      return results.length
      `,
      fake([]),
    )
    expect(result.error).toBe(true)
    expect(result.output.toLowerCase()).toContain("limit")
  })

  test("an aborted signal stops a long-running call", async () => {
    const controller = new AbortController()
    const inner: CodeModeTool.Inner[] = [
      {
        id: "bash",
        description: "sleep",
        parameters: z.object({ command: z.string() }),
        run: () => new Promise(() => {}),
      },
    ]
    const pending = CodeModeTool.run(`return await tools.bash({ command: "x" })`, inner, controller.signal)
    setTimeout(() => controller.abort(), 50)
    const outcome = await Promise.race([
      pending.then(() => "finished").catch(() => "aborted"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ])
    expect(outcome).not.toBe("hung")
  })
})
