export * as SessionRunnerLLM from "./llm.js"

import { AIError, Message, isContextOverflowFailure } from "@opencode/ai"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Effect, Exit, FiberMap, Layer, Stream } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionHistory } from "../history.js"
import { SessionProviderContext } from "../provider-context.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { toSessionError } from "../to-session-error.js"
import { DrainResult, Service, type Interface } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionStep } from "./step.js"
import { ToolOutput } from "../../tool-output.js"
import { Plugin } from "../../plugin.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"
import { CostQuota } from "../../jitda/cost-quota.js"
import { ModelFallback } from "../../jitda/model-fallback.js"
import { Vision } from "../../jitda/vision.js"

// 재시도로 못 고친 모델 오류만 다음 모델로 넘긴다. 사용자 중단과 컨텍스트 초과는 넘기지 않는다.
const fallbackable = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return false
  const error = Cause.squash(cause)
  if (error instanceof AIError) return !isContextOverflowFailure(error)
  return error instanceof StepFailedError && error.error.type !== "aborted"
}

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const title = yield* SessionTitle.Service
    const steps = yield* SessionStep.make
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()
    yield* bus.subscribe([SessionEvent.Step.Ended, SessionEvent.Step.Failed]).pipe(
      Stream.runForEach((event) => Effect.sync(() => CostQuota.consume(event.data.cost ?? 0))),
      Effect.forkScoped,
    )

    const drain = Effect.fn("SessionRunner.drain")(function* (input: Parameters<Interface["drain"]>[0]) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      const turn = { model: 0 }
      const promotable = input.promotable ?? "input"
      if (!force && !continuing) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({ force, continuation: continuing ? { step } : undefined })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID: next.id }],
                    ])
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({ continuation: continuing ? { step } : undefined })
              if (pending?.type === "compaction") {
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session)
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    const history = yield* SessionHistory.preview(
                      db,
                      sessionID,
                      selected.instructions,
                      SessionProviderContext.provenance(model) ?? "local",
                    )
                    return yield* compaction.compact({
                      reason: "manual",
                      inputID: pending.id,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: "manual",
                        inputID: pending.id,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer")))
                return DrainResult.Complete()
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (
                    promoted > 0 &&
                    !selected.session.parentID &&
                    SessionTitle.isUntitled(selected.session) &&
                    !(yield* Effect.promise(() => CostQuota.check()))?.exhausted
                  )
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) {
                    step = 1
                    turn.model = 0
                  }
                  return { _tag: "Ready" as const, context: yield* context.load(selected) }
                }),
              )
              if (ready) return ready
            }
          }),
        ),
      )

      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        continuing = yield* runStep(next.context, step, turn)
        step++
        force = false
        entering = false
      }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    const resolveRef = (
      loaded: SessionContext.Loaded,
      ref: { readonly providerID: string; readonly modelID: string },
      variant?: string,
    ) =>
      context.resolveModel({
        ...loaded.session,
        model: Model.Ref.make({
          providerID: Provider.ID.make(ref.providerID),
          id: Model.ID.make(ref.modelID),
          ...(variant ? { variant: Model.VariantID.make(variant) } : {}),
        }),
      })

    const visionModel = Effect.fn("SessionRunner.visionModel")(function* (loaded: SessionContext.Loaded) {
      const user = loaded.messages.findLast((message) => message.type === "user")
      if (!Vision.wanted(user?.type === "user" ? user : undefined, loaded.model.capabilities.input)) return undefined
      const target = Vision.target()
      if (!target) return undefined
      if (target.providerID === loaded.model.ref.providerID && target.modelID === loaded.model.ref.id) return undefined
      return yield* resolveRef(loaded, target, target.variant ?? loaded.model.ref.variant).pipe(
        Effect.catch(() => resolveRef(loaded, target)),
        Effect.orElseSucceed(() => undefined),
      )
    })

    const fallbackChain = Effect.fn("SessionRunner.fallbackChain")(function* (
      loaded: SessionContext.Loaded,
      primary: SessionContext.Loaded["model"],
    ) {
      const chain = [primary]
      for (const item of ModelFallback.candidates({ providerID: primary.ref.providerID, modelID: primary.ref.id })) {
        const resolve = (variant?: string) => resolveRef(loaded, item, variant)
        const resolved = yield* resolve(item.variant ?? primary.ref.variant).pipe(
          Effect.catch(() => resolve()),
          Effect.orElseSucceed(() => undefined),
        )
        if (
          resolved &&
          !chain.some(
            (existing) => existing.ref.providerID === resolved.ref.providerID && existing.ref.id === resolved.ref.id,
          )
        )
          chain.push(resolved)
      }
      return chain
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (
      first: SessionContext.Loaded,
      step: number,
      turn: { model: number },
    ) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      let retry = yield* SessionRunnerRetry.make(bus, sessionID)
      let initial: SessionContext.Loaded | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      while (true) {
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const loaded = initial ?? (yield* prepareContext(sessionID).pipe(Effect.flatMap(context.load)))
        initial = undefined
        const refused = yield* Effect.promise(() =>
          CostQuota.refusal(CostQuota.locale(loaded.messages.findLast((m) => m.type === "user")?.metadata?.locale)),
        )
        if (refused) return yield* new StepFailedError({ error: { type: "cost-quota", message: refused } })
        const compacted = yield* compaction.compact({ reason: "auto", context: loaded })
        if (compacted.status === "failed") return yield* new StepFailedError({ error: compacted.error })
        if (compacted.status === "completed") {
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        const primary = (yield* visionModel(loaded)) ?? loaded.model
        let resolvedChain: Array<SessionContext.Loaded["model"]> | undefined
        const chain = Effect.suspend(() =>
          resolvedChain
            ? Effect.succeed(resolvedChain)
            : fallbackChain(loaded, primary).pipe(Effect.tap((value) => Effect.sync(() => (resolvedChain = value)))),
        )
        const index = turn.model === 0 ? 0 : Math.min(turn.model, (yield* chain).length - 1)
        const model = index === 0 ? primary : (yield* chain)[index]
        const canFallback = chain.pipe(Effect.map((value) => index < value.length - 1))
        const retries = index === 0 && ModelFallback.degraded(sessionID) ? 0 : ModelFallback.retries()
        const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model,
          tools: loaded.tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        const prepared = yield* context.request.primary({
          session: loaded.session,
          agent: loaded.agent.id,
          model,
          tools: loaded.tools,
          system: transcript.system,
          messages: stepLimitReached
            ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
            : transcript.messages,
          // Keep tool definitions on the final Step to preserve the provider's cached prefix.
          toolChoice: stepLimitReached ? "none" : undefined,
          webSocket: "session",
          inputTokens: SessionCompaction.estimatePrompt(loaded),
        })
        const attempted = yield* steps
          .attempt({
            isLocationClosed: lifecycle.isClosed,
            sessionID,
            assistantMessageID,
            agent: loaded.agent.id,
            model,
            prepared,
            retry: (cause, error, proposed) =>
              retry
                .decide({
                  cause,
                  error,
                  agent: loaded.agent.id,
                  model: model.ref,
                  hook: prepared.retry,
                  retry: proposed,
                })
                .pipe(
                  Effect.flatMap((decision) =>
                    decision.retry && decision.attempt - 1 > retries
                      ? canFallback.pipe(Effect.map((fallback) => (fallback ? { retry: false as const } : decision)))
                      : Effect.succeed(decision),
                  ),
                ),
            recoverContinuation,
            recoverOverflow: Effect.suspend(() =>
              recoverOverflow
                ? compaction
                    .compact({ reason: "overflow", context: loaded })
                    .pipe(Effect.map((result) => result.status === "completed"))
                : Effect.succeed(false),
            ),
          })
          .pipe(Effect.exit)
        if (Exit.isFailure(attempted)) {
          if (!fallbackable(attempted.cause) || !(yield* canFallback)) return yield* Effect.failCause(attempted.cause)
          yield* Effect.logWarning("model failed, falling back", { sessionID, model: model.ref })
          ModelFallback.record(sessionID)
          turn.model = index + 1
          retry = yield* SessionRunnerRetry.make(bus, sessionID)
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        const outcome = attempted.value
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: (outcome) => Effect.succeed(outcome.needsContinuation),
          Retry: (outcome) =>
            retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            }),
          Continue: Effect.fnUntraced(function* (outcome) {
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
          }),
          OutputLimit: Effect.fn("SessionRunner.continueOutputLimit")(function* (outcome) {
            // The current response is included. User input or any other finish breaks the streak.
            const rows = yield* db
              .select()
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  inArray(SessionMessageTable.type, ["user", "assistant"]),
                ),
              )
              .orderBy(desc(SessionMessageTable.seq))
              .limit(3)
              .all()
              .pipe(Effect.orDie)
            const recent = yield* Effect.forEach(rows, SessionHistory.decodeMessageRow)
            const exhausted =
              recent.length === 3 &&
              recent.every((message) => message.type === "assistant" && message.finish === "length")
            if (exhausted)
              return yield* new StepFailedError({
                error: {
                  type: "output-limit",
                  message: "Response still truncated after two output token limit continuations",
                },
              })
            if (outcome.needsContinuation) return true
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_OUTPUT_LIMIT })
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
        })
        if (completed !== undefined) {
          if (index === 0) ModelFallback.recovered(sessionID)
          return completed
        }
      }
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* store.context(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({ drain })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    LocationLifecycle.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    Plugin.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
  ],
})
