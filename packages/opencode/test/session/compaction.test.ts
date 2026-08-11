import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { APICallError } from "ai"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import * as Stream from "effect/Stream"
import path from "path"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "../../src/util/token"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider/provider"
import * as ProviderModule from "../../src/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { Snapshot } from "../../src/snapshot"

Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

async function user(sessionID: SessionID, text: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

async function assistant(sessionID: SessionID, parentID: MessageID, root: string) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await Session.updateMessage(msg)
  return msg
}

async function tool(
  sessionID: SessionID,
  messageID: MessageID,
  tool: string,
  output: string,
  attachments?: MessageV2.ToolStateCompleted["attachments"],
) {
  return Session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    callID: crypto.randomUUID(),
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title: "done",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
      ...(attachments ? { attachments } : {}),
    },
  })
}

/** 페이지 오브젝트가 평문으로 보이는 최소 PDF. 페이지 수만 정확하면 되는 픽스처다. */
function pdfAttachment(sessionID: SessionID, messageID: MessageID, pages: number): MessageV2.FilePart {
  const body =
    `%PDF-1.4\n` +
    Array.from({ length: pages }, (_, i) => `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`).join("") +
    `%%EOF\n`
  return {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "file",
    mime: "application/pdf",
    filename: `scan-${pages}p.pdf`,
    url: `data:application/pdf;base64,${Buffer.from(body, "latin1").toString("base64")}`,
  }
}

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    abort: Effect.fn("TestSessionProcessor.abort")(() => Effect.void),
    partFromToolCall() {
      return {
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "tool",
        callID: "fake",
        tool: "fake",
        state: { status: "pending", input: {}, raw: "" },
      }
    },
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function layer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result))),
    }),
  )
}

function runtime(result: "continue" | "compact", plugin = Plugin.defaultLayer) {
  const bus = Bus.layer
  return ManagedRuntime.make(
    Layer.mergeAll(SessionCompaction.layer, bus).pipe(
      Layer.provide(Session.defaultLayer),
      Layer.provide(layer(result)),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(plugin),
      Layer.provide(bus),
      Layer.provide(Config.defaultLayer),
    ),
  )
}

function llm() {
  const queue: Array<
    Stream.Stream<LLM.Event, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLM.Event, unknown>)
  > = []

  return {
    push(stream: Stream.Stream<LLM.Event, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLM.Event, unknown>)) {
      queue.push(stream)
    },
    layer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          const item = queue.shift() ?? Stream.empty
          const stream = typeof item === "function" ? item(input) : item
          return stream.pipe(Stream.mapEffect((event) => Effect.succeed(event)))
        },
      }),
    ),
  }
}

function liveRuntime(layer: Layer.Layer<LLM.Service>) {
  const bus = Bus.layer
  const status = SessionStatus.layer.pipe(Layer.provide(bus))
  const processor = SessionProcessorModule.SessionProcessor.layer
  return ManagedRuntime.make(
    Layer.mergeAll(SessionCompaction.layer.pipe(Layer.provide(processor)), processor, bus, status).pipe(
      Layer.provide(Session.defaultLayer),
      Layer.provide(Snapshot.defaultLayer),
      Layer.provide(layer),
      Layer.provide(Permission.layer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(status),
      Layer.provide(bus),
      Layer.provide(Config.defaultLayer),
    ),
  )
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function plugin(ready: ReturnType<typeof defer>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => ready.resolve()).pipe(Effect.andThen(Effect.never), Effect.as(output))
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

describe("session.compaction.isOverflow", () => {
  test("returns true when token count exceeds usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("returns false when token count within usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("includes cache.read in token count", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("respects input limit for input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("returns false when input/output are within input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("returns false when output within limit with input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  // ─── Bug reproduction tests ───────────────────────────────────────────
  // These tests demonstrate that when limit.input is set, isOverflow()
  // does not subtract any headroom for the next model response. This means
  // compaction only triggers AFTER we've already consumed the full input
  // budget, leaving zero room for the next API call's output tokens.
  //
  // Compare: without limit.input, usable = context - output (reserves space).
  // With limit.input, usable = limit.input (reserves nothing).
  //
  // Related issues: #10634, #8089, #11086, #12621
  // Open PRs: #6875, #12924

  test("BUG: no headroom when limit.input is set — compaction should trigger near boundary but does not", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Simulate Claude with prompt caching: input limit = 200K, output limit = 32K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })

        // We've used 198K tokens total. Only 2K under the input limit.
        // On the next turn, the full conversation (198K) becomes input,
        // plus the model needs room to generate output — this WILL overflow.
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 180K + 3K + 15K = 198K
        // usable = limit.input = 200K (no output subtracted!)
        // 198K > 200K = false → no compaction triggered

        // WITHOUT limit.input: usable = 200K - 32K = 168K, and 198K > 168K = true ✓
        // WITH limit.input: usable = 200K, and 198K > 200K = false ✗

        // With 198K used and only 2K headroom, the next turn will overflow.
        // Compaction MUST trigger here.
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("BUG: without limit.input, same token count correctly triggers compaction", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Same model but without limit.input — uses context - output instead
        const model = createModel({ context: 200_000, output: 32_000 })

        // Same token usage as above
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 198K
        // usable = context - output = 200K - 32K = 168K
        // 198K > 168K = true → compaction correctly triggered

        const result = await SessionCompaction.isOverflow({ tokens, model })
        expect(result).toBe(true) // ← Correct: headroom is reserved
      },
    })
  })

  test("BUG: asymmetry — limit.input model allows 30K more usage before compaction than equivalent model without it", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Two models with identical context/output limits, differing only in limit.input
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })

        // 170K total tokens — well above context-output (168K) but below input limit (200K)
        const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } }

        const withLimit = await SessionCompaction.isOverflow({ tokens, model: withInputLimit })
        const withoutLimit = await SessionCompaction.isOverflow({ tokens, model: withoutInputLimit })

        // Both models have identical real capacity — they should agree:
        expect(withLimit).toBe(true) // should compact (170K leaves no room for 32K output)
        expect(withoutLimit).toBe(true) // correctly compacts (170K > 168K)
      },
    })
  })

  test("returns false when model context limit is 0", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("returns false when compaction.auto is disabled", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            compaction: { auto: false },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })
})

describe("session.compaction.create", () => {
  test("creates a compaction user message and part", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const msgs = await Session.messages({ sessionID: session.id })
        expect(msgs).toHaveLength(1)
        expect(msgs[0].info.role).toBe("user")
        expect(msgs[0].parts).toHaveLength(1)
        expect(msgs[0].parts[0]).toMatchObject({
          type: "compaction",
          auto: true,
          overflow: true,
        })
      },
    })
  })
})

describe("session.compaction.prune", () => {
  test("compacts old completed tool output", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const a = await user(session.id, "first")
        const b = await assistant(session.id, a.id, tmp.path)
        await tool(session.id, b.id, "bash", "x".repeat(200_000))
        await user(session.id, "second")
        await user(session.id, "third")

        await SessionCompaction.prune({ sessionID: session.id })

        const msgs = await Session.messages({ sessionID: session.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        expect(part?.state.status).toBe("completed")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeNumber()
        }
      },
    })
  })

  // Read 가 스캔본을 돌려주면 output 은 "PDF read successfully" 한 줄이고 무게는 전부 첨부에 있다.
  // 텍스트만 세던 시절엔 이 파트가 PRUNE_MINIMUM 을 못 넘겨 prune 이 통째로 no-op 이었다.
  test("첨부만 무거운 툴 결과도 prune 대상이 된다", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const a = await user(session.id, "first")
        const b = await assistant(session.id, a.id, tmp.path)
        // 20페이지 ≈ 54k 토큰 — PRUNE_PROTECT(40k)와 PRUNE_MINIMUM(20k)을 모두 넘긴다.
        await tool(session.id, b.id, "read", "PDF read successfully", [pdfAttachment(session.id, b.id, 20)])
        await user(session.id, "second")
        await user(session.id, "third")

        await SessionCompaction.prune({ sessionID: session.id })

        const msgs = await Session.messages({ sessionID: session.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeNumber()
        } else {
          throw new Error("completed tool part not found")
        }
      },
    })
  })

  test("작은 첨부는 여전히 보호 구간에 남는다", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const a = await user(session.id, "first")
        const b = await assistant(session.id, a.id, tmp.path)
        // 1페이지 ≈ 2.7k 토큰. 회계에는 잡히지만 게이트를 넘길 만큼은 아니다.
        await tool(session.id, b.id, "read", "PDF read successfully", [pdfAttachment(session.id, b.id, 1)])
        await user(session.id, "second")
        await user(session.id, "third")

        await SessionCompaction.prune({ sessionID: session.id })

        const msgs = await Session.messages({ sessionID: session.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        } else {
          throw new Error("completed tool part not found")
        }
      },
    })
  })

  test("skips protected skill tool output", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const a = await user(session.id, "first")
        const b = await assistant(session.id, a.id, tmp.path)
        await tool(session.id, b.id, "skill", "x".repeat(200_000))
        await user(session.id, "second")
        await user(session.id, "third")

        await SessionCompaction.prune({ sessionID: session.id })

        const msgs = await Session.messages({ sessionID: session.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      },
    })
  })
})

describe("session.compaction.process", () => {
  test("throws when parent is not a user message", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const reply = await assistant(session.id, msg.id, tmp.path)
        const rt = runtime("continue")
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          await expect(
            rt.runPromise(
              SessionCompaction.Service.use((svc) =>
                svc.process({
                  parentID: reply.id,
                  messages: msgs,
                  sessionID: session.id,
                  auto: false,
                }),
              ),
            ),
          ).rejects.toThrow(`Compaction parent must be a user message: ${reply.id}`)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("publishes compacted event on continue", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const msgs = await Session.messages({ sessionID: session.id })
        const done = defer()
        let seen = false
        const rt = runtime("continue")
        let unsub: (() => void) | undefined
        try {
          unsub = await rt.runPromise(
            Bus.Service.use((svc) =>
              svc.subscribeCallback(SessionCompaction.Event.Compacted, (evt) => {
                if (evt.properties.sessionID !== session.id) return
                seen = true
                done.resolve()
              }),
            ),
          )

          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          await Promise.race([
            done.promise,
            wait(500).then(() => {
              throw new Error("timed out waiting for compacted event")
            }),
          ])
          expect(result).toBe("continue")
          expect(seen).toBe(true)
        } finally {
          unsub?.()
          await rt.dispose()
        }
      },
    })
  })

  test("marks summary message as errored on compact result", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const rt = runtime("compact")
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const summary = (await Session.messages({ sessionID: session.id })).find(
            (msg) => msg.info.role === "assistant" && msg.info.summary,
          )

          expect(result).toBe("stop")
          expect(summary?.info.role).toBe("assistant")
          if (summary?.info.role === "assistant") {
            expect(summary.info.finish).toBe("error")
            expect(JSON.stringify(summary.info.error)).toContain("Session too large to compact")
          }
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("adds synthetic continue prompt when auto is enabled", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const rt = runtime("continue")
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: true,
              }),
            ),
          )

          const all = await Session.messages({ sessionID: session.id })
          const last = all.at(-1)

          expect(result).toBe("continue")
          expect(last?.info.role).toBe("user")
          expect(last?.parts[0]).toMatchObject({
            type: "text",
            synthetic: true,
          })
          if (last?.parts[0]?.type === "text") {
            expect(last.parts[0].text).toContain("Continue if you have next steps")
          }
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("replays the prior user turn on overflow when earlier context exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        await user(session.id, "root")
        const replay = await user(session.id, "image")
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: replay.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "cat.png",
          url: "https://example.com/cat.png",
        })
        const msg = await user(session.id, "current")
        const rt = runtime("continue")
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: true,
                overflow: true,
              }),
            ),
          )

          const last = (await Session.messages({ sessionID: session.id })).at(-1)

          expect(result).toBe("continue")
          expect(last?.info.role).toBe("user")
          expect(last?.parts.some((part) => part.type === "file")).toBe(false)
          expect(
            last?.parts.some((part) => part.type === "text" && part.text.includes("Attached image/png: cat.png")),
          ).toBe(true)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("falls back to overflow guidance when no replayable turn exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        await user(session.id, "earlier")
        const msg = await user(session.id, "current")

        const rt = runtime("continue")
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: true,
                overflow: true,
              }),
            ),
          )

          const last = (await Session.messages({ sessionID: session.id })).at(-1)

          expect(result).toBe("continue")
          expect(last?.info.role).toBe("user")
          if (last?.parts[0]?.type === "text") {
            expect(last.parts[0].text).toContain("previous request exceeded the provider's size limit")
          }
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("stops quickly when aborted during retry backoff", async () => {
    const stub = llm()
    const ready = defer()
    stub.push(
      Stream.fromAsyncIterable(
        {
          async *[Symbol.asyncIterator]() {
            yield { type: "start" } as LLM.Event
            throw new APICallError({
              message: "boom",
              url: "https://example.com/v1/chat/completions",
              requestBodyValues: {},
              statusCode: 503,
              responseHeaders: { "retry-after-ms": "10000" },
              responseBody: '{"error":"boom"}',
              isRetryable: true,
            })
          },
        },
        (err) => err,
      ),
    )

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const msgs = await Session.messages({ sessionID: session.id })
        const abort = new AbortController()
        const rt = liveRuntime(stub.layer)
        let off: (() => void) | undefined
        let run: Promise<"continue" | "stop"> | undefined
        try {
          off = await rt.runPromise(
            Bus.Service.use((svc) =>
              svc.subscribeCallback(SessionStatus.Event.Status, (evt) => {
                if (evt.properties.sessionID !== session.id) return
                if (evt.properties.status.type !== "retry") return
                ready.resolve()
              }),
            ),
          )

          run = rt
            .runPromiseExit(
              SessionCompaction.Service.use((svc) =>
                svc.process({
                  parentID: msg.id,
                  messages: msgs,
                  sessionID: session.id,
                  auto: false,
                }),
              ),
              { signal: abort.signal },
            )
            .then((exit) => {
              if (Exit.isFailure(exit)) {
                if (Cause.hasInterrupts(exit.cause) && abort.signal.aborted) return "stop"
                throw Cause.squash(exit.cause)
              }
              return exit.value
            })

          await Promise.race([
            ready.promise,
            wait(1000).then(() => {
              throw new Error("timed out waiting for retry status")
            }),
          ])

          const start = Date.now()
          abort.abort()
          const result = await Promise.race([
            run.then((value) => ({ kind: "done" as const, value, ms: Date.now() - start })),
            wait(250).then(() => ({ kind: "timeout" as const })),
          ])

          expect(result.kind).toBe("done")
          if (result.kind === "done") {
            expect(result.value).toBe("stop")
            expect(result.ms).toBeLessThan(250)
          }
        } finally {
          off?.()
          abort.abort()
          await rt.dispose()
          await run?.catch(() => undefined)
        }
      },
    })
  })

  test("does not leave a summary assistant when aborted before processor setup", async () => {
    const ready = defer()

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const msgs = await Session.messages({ sessionID: session.id })
        const abort = new AbortController()
        const rt = runtime("continue", plugin(ready))
        let run: Promise<"continue" | "stop"> | undefined
        try {
          run = rt
            .runPromiseExit(
              SessionCompaction.Service.use((svc) =>
                svc.process({
                  parentID: msg.id,
                  messages: msgs,
                  sessionID: session.id,
                  auto: false,
                }),
              ),
              { signal: abort.signal },
            )
            .then((exit) => {
              if (Exit.isFailure(exit)) {
                if (Cause.hasInterrupts(exit.cause) && abort.signal.aborted) return "stop"
                throw Cause.squash(exit.cause)
              }
              return exit.value
            })

          await Promise.race([
            ready.promise,
            wait(1000).then(() => {
              throw new Error("timed out waiting for compaction hook")
            }),
          ])

          abort.abort()
          expect(await run).toBe("stop")

          const all = await Session.messages({ sessionID: session.id })
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
        } finally {
          abort.abort()
          await rt.dispose()
          await run?.catch(() => undefined)
        }
      },
    })
  })

  test("does not allow tool calls while generating the summary", async () => {
    const stub = llm()
    stub.push(
      Stream.make(
        { type: "start" } satisfies LLM.Event,
        { type: "tool-input-start", id: "call-1", toolName: "_noop" } satisfies LLM.Event,
        { type: "tool-call", toolCallId: "call-1", toolName: "_noop", input: {} } satisfies LLM.Event,
        {
          type: "finish-step",
          finishReason: "tool-calls",
          rawFinishReason: "tool_calls",
          response: { id: "res", modelId: "test-model", timestamp: new Date() },
          providerMetadata: undefined,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: undefined,
              reasoningTokens: undefined,
            },
          },
        } satisfies LLM.Event,
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "tool_calls",
          totalUsage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: undefined,
              reasoningTokens: undefined,
            },
          },
        } satisfies LLM.Event,
      ),
    )

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const rt = liveRuntime(stub.layer)
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const summary = (await Session.messages({ sessionID: session.id })).find(
            (item) => item.info.role === "assistant" && item.info.summary,
          )

          expect(summary?.info.role).toBe("assistant")
          expect(summary?.parts.some((part) => part.type === "tool")).toBe(false)
        } finally {
          await rt.dispose()
        }
      },
    })
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("session.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles reasoning tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        reasoningTokens: 100,
      },
    })

    expect(result.tokens.reasoning).toBe(100)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
      },
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      // AI SDK v6: inputTokens includes cached tokens for all providers
      const usage = {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      }
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = Session.getUsage({
          model,
          usage,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = Session.getUsage({
        model,
        usage,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
      expect(result.tokens.total).toBe(1500)
    },
  )
})

function capturing(result: "continue" | "compact") {
  const calls: Array<Parameters<SessionProcessorModule.SessionProcessor.Handle["process"]>[0]> = []
  const service = Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("CapturingSessionProcessor.create")((input) =>
        Effect.succeed({
          ...fake(input, result),
          process: Effect.fn("CapturingSessionProcessor.process")((processInput) => {
            calls.push(processInput)
            return Effect.succeed(result)
          }),
        } satisfies SessionProcessorModule.SessionProcessor.Handle),
      ),
    }),
  )
  const bus = Bus.layer
  return {
    calls,
    runtime: ManagedRuntime.make(
      Layer.mergeAll(SessionCompaction.layer, bus).pipe(
        Layer.provide(Session.defaultLayer),
        Layer.provide(service),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(bus),
        Layer.provide(Config.defaultLayer),
      ),
    ),
  }
}

describe("session.compaction.process request", () => {
  test("serializes history as text with tool output capped and attachments described", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const reply = await assistant(session.id, msg.id, tmp.path)
        const pdf = pdfAttachment(session.id, reply.id, 3)
        const output = "A".repeat(40_000)
        await tool(session.id, reply.id, "read", output, [pdf])
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: true,
        })

        const msgs = await Session.messages({ sessionID: session.id })
        const parentID = msgs.at(-1)!.info.id
        const { calls, runtime: rt } = capturing("continue")
        try {
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({ parentID, messages: msgs, sessionID: session.id, auto: true }),
            ),
          )
        } finally {
          await rt.dispose()
        }

        expect(calls).toHaveLength(1)
        const sent = calls[0].messages
        // The whole conversation collapses into a single user turn instead of being replayed.
        expect(sent).toHaveLength(1)
        expect(sent[0].role).toBe("user")

        const text = JSON.stringify(sent)
        expect(text).toContain("[User]: hello")
        expect(text).toContain("[Tool result]:")
        expect(text).toContain("[truncated]")
        expect(text).toContain("[Attached application/pdf: scan-3p.pdf]")
        // The attachment is described, never carried as bytes.
        expect(text).not.toContain(pdf.url.slice(-64))
        // 40k of tool output is capped near TOOL_OUTPUT_MAX_CHARS rather than resent whole.
        expect(text).not.toContain(output)
        expect(text.length).toBeLessThan(10_000)
        // The compaction message itself carries no history, so it is not echoed back.
        expect(text.split("[User]:")).toHaveLength(2)
      },
    })
  })

  test("carries the saved path of an attachment into the summary input", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "look at this")
        const saved = path.join(tmp.path, "shot.png")
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "shot.png",
          url: "data:image/png;base64,AAAA",
          saved,
        })
        await assistant(session.id, msg.id, tmp.path)
        await SessionCompaction.create({ sessionID: session.id, agent: "build", model: ref, auto: true })

        const msgs = await Session.messages({ sessionID: session.id })
        const parentID = msgs.at(-1)!.info.id
        const { calls, runtime: rt } = capturing("continue")
        try {
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({ parentID, messages: msgs, sessionID: session.id, auto: true }),
            ),
          )
        } finally {
          await rt.dispose()
        }

        // Media is deferred to a Read of the saved copy, so dropping the path here would leave the
        // summary describing an attachment that nothing downstream can reach.
        const text = JSON.parse(JSON.stringify(calls[0].messages))[0].content[0].text
        expect(text).toContain(`[Attached image/png: shot.png — saved at ${saved}]`)
      },
    })
  })

  test("placeholders oversized text parts so the request cannot overflow on its own", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const huge = "B".repeat(MessageV2.STRIP_TEXT_LIMIT + 1)
        await user(session.id, huge)
        await SessionCompaction.create({ sessionID: session.id, agent: "build", model: ref, auto: true })

        const msgs = await Session.messages({ sessionID: session.id })
        const parentID = msgs.at(-1)!.info.id
        const { calls, runtime: rt } = capturing("continue")
        try {
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({ parentID, messages: msgs, sessionID: session.id, auto: true }),
            ),
          )
        } finally {
          await rt.dispose()
        }

        const text = JSON.stringify(calls[0].messages)
        expect(text).toContain(MessageV2.stripTextPlaceholder(huge.length))
        expect(text).not.toContain(huge)
      },
    })
  })

  test("summarizes only the head and records where the retained tail starts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const first = await user(session.id, "first turn")
        await assistant(session.id, first.id, tmp.path)
        const second = await user(session.id, "second turn")
        await assistant(session.id, second.id, tmp.path)
        const third = await user(session.id, "third turn")
        await assistant(session.id, third.id, tmp.path)
        await SessionCompaction.create({ sessionID: session.id, agent: "build", model: ref, auto: true })

        const msgs = await Session.messages({ sessionID: session.id })
        const parentID = msgs.at(-1)!.info.id
        const { calls, runtime: rt } = capturing("continue")
        try {
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({ parentID, messages: msgs, sessionID: session.id, auto: true }),
            ),
          )
        } finally {
          await rt.dispose()
        }

        // tail_turns defaults to 2, so the last two turns stay out of the summary entirely.
        const text = JSON.stringify(calls[0].messages)
        expect(text).toContain("first turn")
        expect(text).not.toContain("second turn")
        expect(text).not.toContain("third turn")

        const after = await Session.messages({ sessionID: session.id })
        const part = after.find((item) => item.info.id === parentID)!.parts.find((item) => item.type === "compaction")
        expect(part).toMatchObject({ tail_start_id: second.id })
      },
    })
  })

  test("summarizes everything when no recent turn fits the preserve budget", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const first = await user(session.id, "first turn")
        await assistant(session.id, first.id, tmp.path)
        const second = await user(session.id, "second turn")
        const reply = await assistant(session.id, second.id, tmp.path)
        await tool(session.id, reply.id, "read", "C".repeat(200_000))
        await SessionCompaction.create({ sessionID: session.id, agent: "build", model: ref, auto: true })

        const msgs = await Session.messages({ sessionID: session.id })
        const parentID = msgs.at(-1)!.info.id
        const { calls, runtime: rt } = capturing("continue")
        try {
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({ parentID, messages: msgs, sessionID: session.id, auto: true }),
            ),
          )
        } finally {
          await rt.dispose()
        }

        const text = JSON.stringify(calls[0].messages)
        expect(text).toContain("first turn")
        expect(text).toContain("second turn")

        const after = await Session.messages({ sessionID: session.id })
        const part = after.find((item) => item.info.id === parentID)!.parts.find((item) => item.type === "compaction")
        expect(part).not.toHaveProperty("tail_start_id")
      },
    })
  })
})

async function summarize(sessionID: SessionID, parentID: MessageID, root: string) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "compaction",
    agent: "compaction",
    path: { cwd: root, root },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    summary: true,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text: "SUMMARY",
  })
  return msg
}

describe("session.message-v2.filterCompacted", () => {
  test("replays the retained tail after the summary", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const first = await user(session.id, "first turn")
        await assistant(session.id, first.id, tmp.path)
        const second = await user(session.id, "second turn")
        const secondReply = await assistant(session.id, second.id, tmp.path)
        await SessionCompaction.create({ sessionID: session.id, agent: "build", model: ref, auto: true })

        const msgs = await Session.messages({ sessionID: session.id })
        const compaction = msgs.at(-1)!
        const part = compaction.parts.find((item) => item.type === "compaction")!
        await Session.updatePart({ ...part, tail_start_id: second.id })
        const summary = await summarize(session.id, compaction.info.id, tmp.path)

        const filtered = await MessageV2.filterCompacted(MessageV2.stream(session.id))
        // Summary first because it stands in for the head, then the turns it deliberately skipped.
        expect(filtered.map((item) => item.info.id)).toEqual([
          compaction.info.id,
          summary.id,
          second.id,
          secondReply.id,
        ])
      },
    })
  })

  test("stops at the compaction boundary when no tail was retained", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const first = await user(session.id, "first turn")
        await assistant(session.id, first.id, tmp.path)
        await SessionCompaction.create({ sessionID: session.id, agent: "build", model: ref, auto: true })

        const msgs = await Session.messages({ sessionID: session.id })
        const compaction = msgs.at(-1)!
        const summary = await summarize(session.id, compaction.info.id, tmp.path)

        const filtered = await MessageV2.filterCompacted(MessageV2.stream(session.id))
        expect(filtered.map((item) => item.info.id)).toEqual([compaction.info.id, summary.id])
      },
    })
  })
})
