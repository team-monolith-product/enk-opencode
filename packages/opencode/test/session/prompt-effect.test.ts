import { NodeFileSystem } from "@effect/platform-node"
import { APICallError } from "ai"
import { expect, spyOn } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, ServiceMap } from "effect"
import * as Stream from "effect/Stream"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { FileTime } from "../../src/file/time"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "../../src/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionFallback } from "../../src/session/fallback"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { TaskTool } from "../../src/tool/task"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Attachment } from "../../src/session/attachment"
import { Log } from "../../src/util/log"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

type Script = Stream.Stream<LLM.Event, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLM.Event, unknown>)

class TestLLM extends ServiceMap.Service<
  TestLLM,
  {
    readonly push: (stream: Script) => Effect.Effect<void>
    readonly reply: (...items: LLM.Event[]) => Effect.Effect<void>
    readonly calls: Effect.Effect<number>
    readonly inputs: Effect.Effect<LLM.StreamInput[]>
  }
>()("@test/PromptLLM") {}

function stream(...items: LLM.Event[]) {
  return Stream.make(...items)
}

function usage(input = 1, output = 1, total = input + output) {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
  }
}

function start(): LLM.Event {
  return { type: "start" }
}

function textStart(id = "t"): LLM.Event {
  return { type: "text-start", id }
}

function textDelta(id: string, text: string): LLM.Event {
  return { type: "text-delta", id, text }
}

function textEnd(id = "t"): LLM.Event {
  return { type: "text-end", id }
}

function finishStep(): LLM.Event {
  return {
    type: "finish-step",
    finishReason: "stop",
    rawFinishReason: "stop",
    response: { id: "res", modelId: "test-model", timestamp: new Date() },
    providerMetadata: undefined,
    usage: usage(),
  }
}

function finish(): LLM.Event {
  return { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: usage() }
}

function finishToolCallsStep(): LLM.Event {
  return {
    type: "finish-step",
    finishReason: "tool-calls",
    rawFinishReason: "tool_calls",
    response: { id: "res", modelId: "test-model", timestamp: new Date() },
    providerMetadata: undefined,
    usage: usage(),
  }
}

function finishToolCalls(): LLM.Event {
  return { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool_calls", totalUsage: usage() }
}

function replyStop(text: string, id = "t") {
  return [start(), textStart(id), textDelta(id, text), textEnd(id), finishStep(), finish()] as const
}

function replyToolCalls(text: string, id = "t") {
  return [start(), textStart(id), textDelta(id, text), textEnd(id), finishToolCallsStep(), finishToolCalls()] as const
}

function toolInputStart(id: string, toolName: string): LLM.Event {
  return { type: "tool-input-start", id, toolName }
}

function toolCall(toolCallId: string, toolName: string, input: unknown): LLM.Event {
  return { type: "tool-call", toolCallId, toolName, input }
}

function hang(_input: LLM.StreamInput, ...items: LLM.Event[]) {
  return stream(...items).pipe(Stream.concat(Stream.fromEffect(Effect.never)))
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

// Wait until the session runner reaches a given state, instead of relying on a fixed
// sleep to let a forked shell/loop register. Runner registration is async (a few ms),
// so a fixed sleep is racy under load — poll the actual state to stay deterministic.
const waitForRunnerState = (
  prompt: SessionPrompt.Interface,
  sessionID: SessionID,
  tag: "Idle" | "Running" | "Shell" | "ShellThenRun",
) =>
  Effect.gen(function* () {
    while ((yield* prompt.runnerState(sessionID)) !== tag) {
      yield* Effect.sleep(1)
    }
  }).pipe(Effect.timeout("10 seconds"))

// Wait until a forked shell has actually persisted its assistant message. The shell's
// message writes run asynchronously inside the forked fiber, after the runner registers,
// so cancelling too early leaves the stream empty and `onInterrupt`/lastAssistant has
// nothing to resolve with.
const waitForAssistantMessage = (sessions: Session.Interface, sessionID: SessionID) =>
  Effect.gen(function* () {
    while (!(yield* sessions.messages({ sessionID })).some((msg) => msg.info.role === "assistant")) {
      yield* Effect.sleep(1)
    }
  }).pipe(Effect.timeout("10 seconds"))

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const llm = Layer.unwrap(
  Effect.gen(function* () {
    const queue: Script[] = []
    const inputs: LLM.StreamInput[] = []
    let calls = 0

    const push = Effect.fn("TestLLM.push")((item: Script) => {
      queue.push(item)
      return Effect.void
    })

    const reply = Effect.fn("TestLLM.reply")((...items: LLM.Event[]) => push(stream(...items)))
    return Layer.mergeAll(
      Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          stream: (input) => {
            calls += 1
            inputs.push(input)
            const item = queue.shift() ?? Stream.empty
            return typeof item === "function" ? item(input) : item
          },
        }),
      ),
      Layer.succeed(
        TestLLM,
        TestLLM.of({
          push,
          reply,
          calls: Effect.sync(() => calls),
          inputs: Effect.sync(() => [...inputs]),
        }),
      ),
    )
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const filetime = Layer.succeed(
  FileTime.Service,
  FileTime.Service.of({
    read: () => Effect.void,
    get: () => Effect.succeed(undefined),
    assert: () => Effect.void,
    withLock: (_filepath, fn) => Effect.promise(fn),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Command.defaultLayer,
  Permission.layer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  filetime,
  lsp,
  mcp,
  AppFileSystem.defaultLayer,
  status,
  SessionFallback.layer,
  llm,
).pipe(Layer.provideMerge(infra))
const registry = ToolRegistry.layer.pipe(Layer.provideMerge(deps))
const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
const attach = Attachment.layer.pipe(Layer.provideMerge(deps))
const proc = SessionProcessor.layer.pipe(Layer.provideMerge(deps))
const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
const env = SessionPrompt.layer.pipe(
  Layer.provideMerge(compact),
  Layer.provideMerge(proc),
  Layer.provideMerge(registry),
  Layer.provideMerge(trunc),
  Layer.provideMerge(attach),
  Layer.provideMerge(deps),
)

const it = testEffect(env)
const unix = process.platform !== "win32" ? it.effect : it.effect.skip

// Config that registers a custom "test" provider with a "test-model" model
// so Provider.getModel("test", "test-model") succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const test = yield* TestLLM
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { test, prompt, sessions, chat }
})

// Loop semantics

it.effect("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { test, prompt, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
        expect(yield* test.calls).toBe(0)
      }),
    { git: true },
  ),
)

it.effect("loop calls LLM and returns assistant message", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { test, prompt, chat } = yield* boot()
        yield* test.reply(...replyStop("world"))
        yield* user(chat.id, "hello")

        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")
        const parts = result.parts.filter((p) => p.type === "text")
        expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
        expect(yield* test.calls).toBe(1)
      }),
    { git: true, config: cfg },
  ),
)

it.effect("loop continues when finish is tool-calls", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { test, prompt, chat } = yield* boot()
        yield* test.reply(...replyToolCalls("first"))
        yield* test.reply(...replyStop("second"))
        yield* user(chat.id, "hello")

        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(yield* test.calls).toBe(2)
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") {
          expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
          expect(result.info.finish).toBe("stop")
        }
      }),
    { git: true, config: cfg },
  ),
)

it.effect("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { test, prompt, chat } = yield* boot({ title: "Pinned" })
        yield* test.reply(
          start(),
          toolInputStart("task-1", "task"),
          toolCall("task-1", "task", {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          }),
          {
            type: "finish-step",
            finishReason: "tool-calls",
            rawFinishReason: "tool_calls",
            response: { id: "res", modelId: "test-model", timestamp: new Date() },
            providerMetadata: undefined,
            usage: usage(),
          },
          { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool_calls", totalUsage: usage() },
        )
        yield* test.reply(...replyStop("done"))
        const msg = yield* user(chat.id, "hello")
        yield* addSubtask(chat.id, msg.id)

        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")
        expect(yield* test.calls).toBe(2)

        const msgs = yield* Effect.promise(() => MessageV2.filterCompacted(MessageV2.stream(chat.id)))
        const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
        expect(taskMsg?.info.role).toBe("assistant")
        if (!taskMsg || taskMsg.info.role !== "assistant") return

        const tool = errorTool(taskMsg.parts)
        if (!tool) return

        expect(tool.state.error).toContain("Tool execution failed")
        expect(tool.state.metadata).toBeDefined()
        expect(tool.state.metadata?.sessionId).toBeDefined()
        expect(tool.state.metadata?.model).toEqual({
          providerID: ProviderID.make("test"),
          modelID: ModelID.make("missing-model"),
        })
      }),
    {
      git: true,
      config: {
        ...cfg,
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      },
    },
  ),
)

it.effect("loop sets status to busy then idle", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const test = yield* TestLLM
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const bus = yield* Bus.Service

        yield* test.reply(start(), textStart(), textDelta("t", "ok"), textEnd(), finishStep(), finish())

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const types: string[] = []
        const idle = defer<void>()
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          types.push(evt.properties.status.type)
          if (evt.properties.status.type === "idle") idle.resolve()
        })

        yield* prompt.loop({ sessionID: chat.id })
        yield* Effect.promise(() => idle.promise)
        off()

        expect(types).toContain("busy")
        expect(types[types.length - 1]).toBe("idle")
      }),
    { git: true, config: cfg },
  ),
)

// Cancel semantics

it.effect(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { test, prompt, chat } = yield* boot()
          yield* seed(chat.id)

          // Make LLM hang so the loop blocks
          yield* test.push((input) => hang(input, start()))

          // Seed a new user message so the loop enters the LLM path
          yield* user(chat.id, "more")

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          // Give the loop time to start
          yield* Effect.sleep(200)
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            expect(exit.value.info.role).toBe("assistant")
          }
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.effect(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const { test, prompt, chat } = yield* boot()

          yield* test.push((input) =>
            hang(input, start()).pipe(
              Stream.tap((event) => (event.type === "start" ? Effect.sync(() => ready.resolve()) : Effect.void)),
            ),
          )
          yield* user(chat.id, "hello")

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            const info = exit.value.info
            if (info.role === "assistant") {
              expect(info.error?.name).toBe("MessageAbortedError")
            }
          }
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.effect(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const init = spyOn(TaskTool, "init").mockImplementation(async () => ({
            description: "task",
            parameters: z.object({
              description: z.string(),
              prompt: z.string(),
              subagent_type: z.string(),
              task_id: z.string().optional(),
              command: z.string().optional(),
            }),
            execute: async (_args, ctx) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              await new Promise<void>(() => {})
              return {
                title: "",
                metadata: {
                  sessionId: SessionID.make("task"),
                  model: ref,
                },
                output: "",
              }
            },
          }))
          yield* Effect.addFinalizer(() => Effect.sync(() => init.mockRestore()))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* Effect.promise(() => MessageV2.filterCompacted(MessageV2.stream(chat.id)))
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.effect(
  "cancel finalizes a dangling assistant message when no runner is active",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()
          // Dangling: assistant message with no time.completed and no busy runner —
          // models a session left stuck by a hung/dead runner.
          const { assistant } = yield* seed(chat.id)

          const before = yield* Effect.promise(() => Array.fromAsync(MessageV2.stream(chat.id)))
          const stuck = before.find((m) => m.info.id === assistant.id)
          expect(stuck?.info.role).toBe("assistant")
          if (stuck?.info.role === "assistant") expect(stuck.info.time.completed).toBeUndefined()

          // Stop on an already-stuck session must recover it.
          yield* prompt.cancel(chat.id)

          const after = yield* Effect.promise(() => Array.fromAsync(MessageV2.stream(chat.id)))
          const recovered = after.find((m) => m.info.id === assistant.id)
          expect(recovered?.info.role).toBe("assistant")
          if (recovered?.info.role === "assistant") {
            expect(recovered.info.time.completed).toBeDefined()
            expect(recovered.info.finish).toBeDefined()
          }
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.effect(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const { test, prompt, chat } = yield* boot()

          yield* test.push((input) =>
            hang(input, start()).pipe(
              Stream.tap((event) => (event.type === "start" ? Effect.sync(() => ready.resolve()) : Effect.void)),
            ),
          )
          yield* user(chat.id, "hello")

          const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          // Queue a second caller
          const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
          expect(Exit.isSuccess(exitA)).toBe(true)
          expect(Exit.isSuccess(exitB)).toBe(true)
          if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
            expect(exitA.value.info.id).toBe(exitB.value.info.id)
          }
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

// Queue semantics

it.effect("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* prompt.assertNotBusy(chat.id)
      }),
    { git: true },
  ),
)

it.effect("concurrent loop callers all receive same error result", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { test, prompt, chat } = yield* boot()

        // Push a stream that fails — the loop records the error on the assistant message
        yield* test.push(Stream.fail(new Error("boom")))
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        // Both callers get the same assistant with an error recorded
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        if (a.info.role === "assistant") {
          expect(a.info.error).toBeDefined()
        }
        if (b.info.role === "assistant") {
          expect(b.info.error).toBeDefined()
        }
      }),
    { git: true, config: cfg },
  ),
)

it.effect(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const gate = defer<void>()
          const { test, prompt, sessions, chat } = yield* boot()

          yield* test.push((_input) =>
            stream(start()).pipe(
              Stream.tap((event) => (event.type === "start" ? Effect.sync(() => ready.resolve()) : Effect.void)),
              Stream.concat(
                Stream.fromEffect(Effect.promise(() => gate.promise)).pipe(
                  Stream.flatMap(() =>
                    stream(textStart("a"), textDelta("a", "first"), textEnd("a"), finishStep(), finish()),
                  ),
                ),
              ),
            ),
          )

          const a = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              model: ref,
              parts: [{ type: "text", text: "first" }],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)

          const id = MessageID.ascending()
          const b = yield* prompt
            .prompt({
              sessionID: chat.id,
              messageID: id,
              agent: "build",
              model: ref,
              parts: [{ type: "text", text: "second" }],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(async () => {
            const end = Date.now() + 5000
            while (Date.now() < end) {
              const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
              if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
              await new Promise((done) => setTimeout(done, 20))
            }
            throw new Error("timed out waiting for second prompt to save")
          })

          yield* test.reply(...replyStop("second"))
          gate.resolve()

          const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
          expect(Exit.isSuccess(ea)).toBe(true)
          expect(Exit.isSuccess(eb)).toBe(true)
          expect(yield* test.calls).toBe(2)

          const msgs = yield* sessions.messages({ sessionID: chat.id })
          const assistants = msgs.filter((msg) => msg.info.role === "assistant")
          expect(assistants).toHaveLength(2)
          const last = assistants.at(-1)
          if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
          expect(last.info.parentID).toBe(id)
          expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

          const inputs = yield* test.inputs
          expect(inputs).toHaveLength(2)
          expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.effect(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const test = yield* TestLLM
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service

          yield* test.push((input) =>
            hang(input, start()).pipe(
              Stream.tap((event) => (event.type === "start" ? Effect.sync(() => ready.resolve()) : Effect.void)),
            ),
          )

          const chat = yield* sessions.create({})
          yield* user(chat.id, "hi")

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)

          const exit = yield* prompt.assertNotBusy(chat.id).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
          }

          yield* prompt.cancel(chat.id)
          yield* Fiber.await(fiber)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.effect("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* prompt.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { git: true },
  ),
)

// Shell semantics

it.effect(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const { test, prompt, chat } = yield* boot()

          yield* test.push((input) =>
            hang(input, start()).pipe(
              Stream.tap((event) => (event.type === "start" ? Effect.sync(() => ready.resolve()) : Effect.void)),
            ),
          )
          yield* user(chat.id, "hi")

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)

          const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
          }

          yield* prompt.cancel(chat.id)
          yield* Fiber.await(fiber)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* prompt.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = await MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { test, prompt, chat } = yield* boot()
          yield* test.reply(...replyStop("after-shell"))

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          expect(yield* test.calls).toBe(0)

          yield* Fiber.await(sh)
          const exit = yield* Fiber.await(run)

          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            expect(exit.value.info.role).toBe("assistant")
            expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
          }
          expect(yield* test.calls).toBe(1)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { test, prompt, chat } = yield* boot()
          yield* test.reply(...replyStop("done"))

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          expect(yield* test.calls).toBe(0)

          yield* Fiber.await(sh)
          const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

          expect(Exit.isSuccess(ea)).toBe(true)
          expect(Exit.isSuccess(eb)).toBe(true)
          if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
            expect(ea.value.info.id).toBe(eb.value.info.id)
            expect(ea.value.info.role).toBe("assistant")
          }
          expect(yield* test.calls).toBe(1)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* prompt.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { prompt, sessions, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          // Shell registers, then asynchronously persists its assistant message — wait for both
          // so the queued loop is genuinely behind a running shell that lastAssistant can resolve.
          yield* waitForRunnerState(prompt, chat.id, "Shell")
          yield* waitForAssistantMessage(sessions, chat.id)

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* waitForRunnerState(prompt, chat.id, "ShellThenRun")

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// Model fallback

// A second model on the same test provider, so the fallback pool resolves without a second SDK.
const cfgFallback = {
  provider: {
    test: {
      ...cfg.provider.test,
      models: {
        ...cfg.provider.test.models,
        "test-fallback": { ...cfg.provider.test.models["test-model"], id: "test-fallback", name: "Test Fallback" },
      },
    },
  },
}

// The flags are read off process.env on every access, so a test can retune them in place.
function withFallbackEnv<A, E, R>(env: Record<string, string | undefined>, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(env)) {
        prev[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(prev)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

function apiFailure(isRetryable: boolean) {
  return Stream.fail(
    new APICallError({
      message: "provider exploded",
      url: "http://localhost:1/v1/chat/completions",
      requestBodyValues: {},
      statusCode: isRetryable ? 429 : 401,
      responseHeaders: { "retry-after-ms": "0" },
      isRetryable,
    }),
  ) as Stream.Stream<LLM.Event, unknown>
}

const POOL = { ENK_AI_FALLBACK_MODELS: '["test/test-fallback"]' }

it.effect("falls back to the next model once the primary exhausts its retries", () =>
  withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "1" }, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { test, prompt, chat } = yield* boot()
          yield* test.push(apiFailure(true))
          yield* test.push(apiFailure(true))
          yield* test.reply(...replyStop("recovered"))
          yield* user(chat.id, "hello")

          const result = yield* prompt.loop({ sessionID: chat.id })

          // one initial attempt plus one retry on the primary, then a single attempt on the fallback
          expect(yield* test.calls).toBe(3)
          const models = (yield* test.inputs).map((input) => input.model.id as string)
          expect(models).toEqual(["test-model", "test-model", "test-fallback"])

          expect(result.info.role).toBe("assistant")
          if (result.info.role === "assistant") {
            expect(result.info.modelID as string).toBe("test-fallback")
            expect(result.info.error).toBeUndefined()
          }
          expect(result.parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        }),
      { git: true, config: cfgFallback },
    ),
  ),
)

it.effect("falls back immediately on an error retrying cannot fix", () =>
  withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "5" }, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { test, prompt, chat } = yield* boot()
          yield* test.push(apiFailure(false))
          yield* test.reply(...replyStop("recovered"))
          yield* user(chat.id, "hello")

          yield* prompt.loop({ sessionID: chat.id })

          // the retry budget is never spent: a different model is the only thing that can help
          expect(yield* test.calls).toBe(2)
          expect((yield* test.inputs).map((input) => input.model.id as string)).toEqual(["test-model", "test-fallback"])
        }),
      { git: true, config: cfgFallback },
    ),
  ),
)

it.effect("discards the empty message left behind by a model that never emitted anything", () =>
  withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "0" }, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { test, prompt, sessions, chat } = yield* boot()
          yield* test.push(apiFailure(false))
          yield* test.reply(...replyStop("recovered"))
          yield* user(chat.id, "hello")

          yield* prompt.loop({ sessionID: chat.id })

          const assistants = (yield* sessions.messages({ sessionID: chat.id })).filter(
            (msg) => msg.info.role === "assistant",
          )
          expect(assistants.length).toBe(1)
          expect(assistants[0].info.role === "assistant" && (assistants[0].info.modelID as string)).toBe(
            "test-fallback",
          )
        }),
      { git: true, config: cfgFallback },
    ),
  ),
)

it.effect("keeps the partial output of a model that failed mid-stream", () =>
  withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "0" }, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { test, prompt, sessions, chat } = yield* boot()
          yield* test.push(
            stream(start(), textStart("t"), textDelta("t", "half a sen")).pipe(Stream.concat(apiFailure(false))),
          )
          yield* test.reply(...replyStop("recovered"))
          yield* user(chat.id, "hello")

          yield* prompt.loop({ sessionID: chat.id })

          const assistants = (yield* sessions.messages({ sessionID: chat.id })).filter(
            (msg) => msg.info.role === "assistant",
          )
          expect(assistants.length).toBe(2)
          expect(assistants[0].parts.some((part) => part.type === "text" && part.text === "half a sen")).toBe(true)
          // the abandoned message must not look like a completed answer, or the loop would stop there
          expect(assistants[0].info.role === "assistant" && assistants[0].info.finish).toBeUndefined()
          expect(assistants[1].parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        }),
      { git: true, config: cfgFallback },
    ),
  ),
)

it.effect("surfaces the error when the pool is exhausted", () =>
  withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "0" }, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { test, prompt, chat } = yield* boot()
          yield* test.push(apiFailure(false))
          yield* test.push(apiFailure(false))
          yield* user(chat.id, "hello")

          const result = yield* prompt.loop({ sessionID: chat.id })

          expect(yield* test.calls).toBe(2)
          expect(result.info.role === "assistant" && result.info.error).toBeDefined()
        }),
      { git: true, config: cfgFallback },
    ),
  ),
)

it.effect("an empty pool disables fallback entirely", () =>
  withFallbackEnv({ ENK_AI_FALLBACK_MODELS: "[]", ENK_AI_FALLBACK_RETRIES: "0" }, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { test, prompt, chat } = yield* boot()
          yield* test.push(apiFailure(false))
          yield* user(chat.id, "hello")

          const result = yield* prompt.loop({ sessionID: chat.id })

          expect(yield* test.calls).toBe(1)
          expect(result.info.role === "assistant" && result.info.error).toBeDefined()
        }),
      { git: true, config: cfgFallback },
    ),
  ),
)

// Exclusion pairs: the ENK_AI_IMAGE_MODEL vision model must not fall back to ENK_AI_MODEL,
// while the text model falling back to its vision partner is allowed (and preferred).

const cfgFallbackGroup = {
  provider: {
    test: {
      ...cfg.provider.test,
      models: {
        ...cfg.provider.test.models,
        "test-fallback": { ...cfg.provider.test.models["test-model"], id: "test-fallback", name: "Test Fallback" },
        "test-fallback2": { ...cfg.provider.test.models["test-model"], id: "test-fallback2", name: "Test Fallback 2" },
      },
    },
  },
}

const PAIR = { ENK_AI_MODEL: "test/test-model", ENK_AI_IMAGE_MODEL: "test/test-fallback" }

it.effect("the text primary falls back to its vision partner first", () =>
  withFallbackEnv(
    { ...PAIR, ENK_AI_FALLBACK_MODELS: '["test/test-fallback", "test/test-fallback2"]', ENK_AI_FALLBACK_RETRIES: "0" },
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            yield* test.push(apiFailure(false))
            yield* test.reply(...replyStop("recovered"))
            yield* user(chat.id, "hello")

            yield* prompt.loop({ sessionID: chat.id })

            // test-fallback is the primary's vision partner; that direction is allowed, so it
            // is the first fallback rather than being skipped for test-fallback2
            expect((yield* test.inputs).map((input) => input.model.id as string)).toEqual([
              "test-model",
              "test-fallback",
            ])
          }),
        { git: true, config: cfgFallbackGroup },
      ),
  ),
)

it.effect("the vision primary skips its text partner in favor of the next pool entry", () =>
  withFallbackEnv(
    { ...PAIR, ENK_AI_FALLBACK_MODELS: '["test/test-model", "test/test-fallback2"]', ENK_AI_FALLBACK_RETRIES: "0" },
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat, sessions } = yield* boot()
            yield* test.push(apiFailure(false))
            yield* test.reply(...replyStop("recovered"))
            const msg = yield* user(chat.id, "hello")
            yield* sessions.updateMessage({
              ...msg,
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-fallback") },
            })

            yield* prompt.loop({ sessionID: chat.id })

            // test-model is the vision primary's text partner — an image turn must not land
            // on a blind model, so the chain jumps straight to test-fallback2
            expect((yield* test.inputs).map((input) => input.model.id as string)).toEqual([
              "test-fallback",
              "test-fallback2",
            ])
          }),
        { git: true, config: cfgFallbackGroup },
      ),
  ),
)

it.effect("a pool holding only the vision primary's text partner leaves no fallback", () =>
  withFallbackEnv({ ...PAIR, ENK_AI_FALLBACK_MODELS: '["test/test-model"]', ENK_AI_FALLBACK_RETRIES: "0" }, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { test, prompt, chat, sessions } = yield* boot()
          yield* test.push(apiFailure(false))
          const msg = yield* user(chat.id, "hello")
          yield* sessions.updateMessage({
            ...msg,
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-fallback") },
          })

          const result = yield* prompt.loop({ sessionID: chat.id })

          expect(yield* test.calls).toBe(1)
          expect(result.info.role === "assistant" && result.info.error).toBeDefined()
        }),
      { git: true, config: cfgFallbackGroup },
    ),
  ),
)

it.effect("the pair rule leaves a primary outside the pair alone", () =>
  // Same pool and pair, but the turn runs on test-fallback2 (outside the pair), so the
  // partner model stays a legitimate fallback.
  withFallbackEnv(
    { ...PAIR, ENK_AI_FALLBACK_MODELS: '["test/test-fallback"]', ENK_AI_FALLBACK_RETRIES: "0" },
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat, sessions } = yield* boot()
            yield* test.push(apiFailure(false))
            yield* test.reply(...replyStop("recovered"))
            const msg = yield* user(chat.id, "hello")
            yield* sessions.updateMessage({
              ...msg,
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-fallback2") },
            })

            yield* prompt.loop({ sessionID: chat.id })

            expect((yield* test.inputs).map((input) => input.model.id as string)).toEqual([
              "test-fallback2",
              "test-fallback",
            ])
          }),
        { git: true, config: cfgFallbackGroup },
      ),
  ),
)

it.effect(
  "a degraded session still gives the primary one attempt per turn",
  () =>
    withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "3", ENK_AI_FALLBACK_STICKY_AFTER: "1" }, () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            // turn one: the primary burns its retry budget, then the fallback answers
            yield* test.push(apiFailure(true))
            yield* test.push(apiFailure(true))
            yield* test.push(apiFailure(true))
            yield* test.push(apiFailure(true))
            yield* test.reply(...replyStop("first"))
            yield* user(chat.id, "hello")
            yield* prompt.loop({ sessionID: chat.id })
            expect(yield* test.calls).toBe(5)

            // turn two: the session is degraded, so the primary gets a single attempt and no retries
            yield* test.push(apiFailure(true))
            yield* test.reply(...replyStop("second"))
            yield* user(chat.id, "again")
            yield* prompt.loop({ sessionID: chat.id })

            expect(yield* test.calls).toBe(7)
            expect((yield* test.inputs).slice(5).map((input) => input.model.id as string)).toEqual([
              "test-model",
              "test-fallback",
            ])
          }),
        { git: true, config: cfgFallback },
      ),
    ),
  30_000,
)

it.effect(
  "a recovered primary clears degraded mode",
  () =>
    withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "1", ENK_AI_FALLBACK_STICKY_AFTER: "1" }, () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            // turn one: the primary spends its one retry, falls back, and degrades the session
            yield* test.push(apiFailure(true))
            yield* test.push(apiFailure(true))
            yield* test.reply(...replyStop("first"))
            yield* user(chat.id, "hello")
            yield* prompt.loop({ sessionID: chat.id })

            // turn two: degraded, so the primary gets a single attempt — and it answers, clearing the mode
            yield* test.reply(...replyStop("second"))
            yield* user(chat.id, "again")
            yield* prompt.loop({ sessionID: chat.id })

            // turn three proves the mode is gone: the primary gets its retry back rather than one shot
            yield* test.push(apiFailure(true))
            yield* test.reply(...replyStop("third"))
            yield* user(chat.id, "once more")
            const result = yield* prompt.loop({ sessionID: chat.id })

            expect((yield* test.inputs).map((input) => input.model.id as string)).toEqual([
              "test-model",
              "test-model",
              "test-fallback",
              "test-model",
              "test-model",
              "test-model",
            ])
            expect(result.info.role === "assistant" && (result.info.modelID as string)).toBe("test-model")
            expect(result.parts.some((part) => part.type === "text" && part.text === "third")).toBe(true)
          }),
        { git: true, config: cfgFallback },
      ),
    ),
  30_000,
)

it.effect(
  "context overflow compacts instead of falling back",
  () =>
    withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "0" }, () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            // 413 is how the provider says "your input is too big" — another model is not the answer,
            // compacting this one's history is.
            yield* test.push(
              Stream.fail(
                new APICallError({
                  message: "input too long",
                  url: "http://localhost:1/v1/chat/completions",
                  requestBodyValues: {},
                  statusCode: 413,
                  isRetryable: false,
                }),
              ) as Stream.Stream<LLM.Event, unknown>,
            )
            yield* test.reply(...replyStop("summary"))
            yield* test.reply(...replyStop("after compaction"))
            yield* user(chat.id, "hello")

            yield* prompt.loop({ sessionID: chat.id })

            const models = yield* test.inputs
            expect(models.every((input) => (input.model.id as string) === "test-model")).toBe(true)
            expect(models.length).toBeGreaterThan(1)
          }),
        { git: true, config: cfgFallback },
      ),
    ),
  30_000,
)

// The primary offers "high"; the fallback only offers "adaptive", mirroring anthropic -> minimax.
const cfgVariants = {
  provider: {
    test: {
      ...cfg.provider.test,
      models: {
        "test-model": { ...cfg.provider.test.models["test-model"], variants: { high: { reasoningEffort: "high" } } },
        "test-fallback": {
          ...cfg.provider.test.models["test-model"],
          id: "test-fallback",
          name: "Test Fallback",
          variants: { adaptive: { thinking: { type: "adaptive" } } },
        },
      },
    },
  },
}

const userWithVariant = Effect.fn("test.userWithVariant")(function* (sessionID: SessionID, variant: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    variant,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text: "hello" })
  return msg
})

it.effect("drops a variant the fallback model does not offer", () =>
  withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "0" }, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { test, prompt, chat } = yield* boot()
          yield* test.push(apiFailure(false))
          yield* test.reply(...replyStop("recovered"))
          yield* userWithVariant(chat.id, "high")

          const result = yield* prompt.loop({ sessionID: chat.id })

          const inputs = yield* test.inputs
          expect(inputs[0].user.variant).toBe("high")
          // "high" is meaningless to the fallback model, so it must not be forwarded
          expect(inputs[1].user.variant).toBeUndefined()
          expect(result.info.role === "assistant" && result.info.variant).toBeUndefined()
        }),
      { git: true, config: cfgVariants },
    ),
  ),
)

it.effect("skips the pool entry that duplicates the primary, wherever it sits", () =>
  // The primary is the pool's *second* entry here: it must not be tried twice, and the entry
  // ahead of it in the pool must not jump the queue.
  withFallbackEnv(
    { ENK_AI_FALLBACK_MODELS: '["test/test-fallback", "test/test-model"]', ENK_AI_FALLBACK_RETRIES: "0" },
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            yield* test.push(apiFailure(false))
            yield* test.push(apiFailure(false))
            yield* user(chat.id, "hello")

            const result = yield* prompt.loop({ sessionID: chat.id })

            // primary, then the one remaining pool entry — then the pool is exhausted
            expect((yield* test.inputs).map((input) => input.model.id as string)).toEqual([
              "test-model",
              "test-fallback",
            ])
            expect(result.info.role === "assistant" && result.info.error).toBeDefined()
          }),
        { git: true, config: cfgFallback },
      ),
  ),
)

it.effect("skips a pool entry this deployment cannot resolve", () =>
  withFallbackEnv(
    {
      ENK_AI_FALLBACK_MODELS: '["test/does-not-exist", "nosuch/provider", "test/test-fallback"]',
      ENK_AI_FALLBACK_RETRIES: "0",
    },
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            yield* test.push(apiFailure(false))
            yield* test.reply(...replyStop("recovered"))
            yield* user(chat.id, "hello")

            yield* prompt.loop({ sessionID: chat.id })

            // the two unresolvable entries never become an attempt
            expect((yield* test.inputs).map((input) => input.model.id as string)).toEqual([
              "test-model",
              "test-fallback",
            ])
          }),
        { git: true, config: cfgFallback },
      ),
  ),
)

it.effect(
  "the fallback model gets its own retry budget",
  () =>
    withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "1" }, () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            yield* test.push(apiFailure(true)) // primary: attempt
            yield* test.push(apiFailure(true)) // primary: retry
            yield* test.push(apiFailure(true)) // fallback: attempt
            yield* test.reply(...replyStop("recovered")) // fallback: retry succeeds
            yield* user(chat.id, "hello")

            const result = yield* prompt.loop({ sessionID: chat.id })

            expect((yield* test.inputs).map((input) => input.model.id as string)).toEqual([
              "test-model",
              "test-model",
              "test-fallback",
              "test-fallback",
            ])
            expect(result.parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
          }),
        { git: true, config: cfgFallback },
      ),
    ),
  30_000,
)

it.effect(
  "a degraded session still gives the fallback model its full retry budget",
  () =>
    withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "1", ENK_AI_FALLBACK_STICKY_AFTER: "1" }, () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            // turn one degrades the session
            yield* test.push(apiFailure(true))
            yield* test.push(apiFailure(true))
            yield* test.reply(...replyStop("first"))
            yield* user(chat.id, "hello")
            yield* prompt.loop({ sessionID: chat.id })

            // turn two: the primary is docked its retry, but the fallback is not
            yield* test.push(apiFailure(true)) // primary: its one and only attempt
            yield* test.push(apiFailure(true)) // fallback: attempt
            yield* test.reply(...replyStop("second")) // fallback: retry succeeds
            yield* user(chat.id, "again")
            yield* prompt.loop({ sessionID: chat.id })

            expect((yield* test.inputs).slice(3).map((input) => input.model.id as string)).toEqual([
              "test-model",
              "test-fallback",
              "test-fallback",
            ])
          }),
        { git: true, config: cfgFallback },
      ),
    ),
  30_000,
)

it.effect(
  "an aborted turn does not fall back",
  () =>
    withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "0" }, () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            yield* test.push((input) => hang(input, start()))
            yield* test.reply(...replyStop("must not run"))
            yield* user(chat.id, "hello")

            const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
            yield* Effect.sleep(200)
            yield* prompt.cancel(chat.id)
            yield* Fiber.await(fiber)

            // the user stopped the turn; handing it to another model would be the opposite of that
            expect(yield* test.calls).toBe(1)
            expect((yield* test.inputs).map((input) => input.model.id as string)).toEqual(["test-model"])
          }),
        { git: true, config: cfgFallback },
      ),
    ),
  30_000,
)

it.effect("applies the variant declared on the pool entry", () =>
  withFallbackEnv(
    {
      ENK_AI_FALLBACK_MODELS: '[{"model": "test/test-fallback", "variant": "adaptive"}]',
      ENK_AI_FALLBACK_RETRIES: "0",
    },
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { test, prompt, chat } = yield* boot()
            yield* test.push(apiFailure(false))
            yield* test.reply(...replyStop("recovered"))
            yield* userWithVariant(chat.id, "high")

            const result = yield* prompt.loop({ sessionID: chat.id })

            const inputs = yield* test.inputs
            expect(inputs[0].user.variant).toBe("high")
            // the pool entry's own variant wins over whatever the user message carried
            expect(inputs[1].user.variant).toBe("adaptive")
            expect(result.info.role === "assistant" && result.info.variant).toBe("adaptive")
          }),
        { git: true, config: cfgVariants },
      ),
  ),
)

it.effect("switching models does not spend the agent's step budget", () =>
  withFallbackEnv({ ...POOL, ENK_AI_FALLBACK_RETRIES: "0" }, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { test, prompt, chat } = yield* boot()
          yield* test.push(apiFailure(false))
          yield* test.reply(...replyStop("recovered"))
          yield* user(chat.id, "hello")

          yield* prompt.loop({ sessionID: chat.id })

          // With a 2-step budget, a fallback that counted as a step would make the retry the *last*
          // step, and the loop appends a synthetic assistant "you are out of steps" message then.
          const inputs = yield* test.inputs
          expect(inputs[1].messages.at(-1)?.role).toBe("user")
        }),
      { git: true, config: { ...cfgFallback, agent: { build: { steps: 2 } } } },
    ),
  ),
)
