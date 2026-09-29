import { Deferred, Effect, Layer, ServiceMap } from "effect"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { SessionID, MessageID } from "@/session/schema"
import { Log } from "@/util/log"
import { ImageRequestID } from "./schema"

// AI 가 그리려는 이미지를 참가자가 버튼으로 승인해야 생성한다. 개수가 정해진 비용이라 AI 판단만으로 쓰지 않는다.
export namespace ImageRequest {
  const log = Log.create({ service: "image-request" })

  export const Quota = z
    .object({ limit: z.number(), used: z.number(), remaining: z.number() })
    .meta({ ref: "ImageQuota" })
  export type Quota = z.infer<typeof Quota>

  export const Info = z
    .object({
      prompt: z.string(),
      path: z.string(),
      size: z.string(),
      background: z.string(),
      quota: Quota.optional(),
    })
    .meta({ ref: "ImageRequestInfo" })
  export type Info = z.infer<typeof Info>

  export const Request = Info.extend({
    id: ImageRequestID.zod,
    sessionID: SessionID.zod,
    tool: z.object({ messageID: MessageID.zod, callID: z.string() }).optional(),
  }).meta({ ref: "ImageRequest" })
  export type Request = z.infer<typeof Request>

  export const Status = z.enum(["approved", "skipped", "canceled"]).meta({ ref: "ImageRequestStatus" })
  export type Status = z.infer<typeof Status>

  export type Result = { status: Status; prompt: string }

  export const Event = {
    Asked: BusEvent.define("image.request.asked", Request),
    Resolved: BusEvent.define(
      "image.request.resolved",
      z.object({ sessionID: SessionID.zod, requestID: ImageRequestID.zod, status: Status }),
    ),
  }

  interface PendingEntry {
    info: Request
    deferred: Deferred.Deferred<Result>
  }

  interface State {
    pending: Map<ImageRequestID, PendingEntry>
  }

  export interface Interface {
    readonly ask: (input: {
      sessionID: SessionID
      info: Info
      tool?: { messageID: MessageID; callID: string }
    }) => Effect.Effect<Result>
    readonly approve: (input: { requestID: ImageRequestID; prompt?: string }) => Effect.Effect<void>
    readonly skip: (requestID: ImageRequestID) => Effect.Effect<void>
    readonly reject: (requestID: ImageRequestID) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Request[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/ImageRequest") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make<State>(
        Effect.fn("ImageRequest.state")(function* () {
          const state = { pending: new Map<ImageRequestID, PendingEntry>() }

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const item of state.pending.values()) {
                yield* Deferred.succeed(item.deferred, { status: "canceled" as Status, prompt: item.info.prompt })
              }
              state.pending.clear()
            }),
          )

          return state
        }),
      )

      const ask = Effect.fn("ImageRequest.ask")(function* (input: {
        sessionID: SessionID
        info: Info
        tool?: { messageID: MessageID; callID: string }
      }) {
        const pending = (yield* InstanceState.get(state)).pending
        const id = ImageRequestID.ascending()
        log.info("asking", { id })

        const deferred = yield* Deferred.make<Result>()
        const info: Request = { ...input.info, id, sessionID: input.sessionID, tool: input.tool }
        pending.set(id, { info, deferred })
        Bus.publish(Event.Asked, info)

        return yield* Effect.ensuring(
          Deferred.await(deferred),
          Effect.sync(() => {
            pending.delete(id)
          }),
        )
      })

      const resolve = Effect.fn("ImageRequest.resolve")(function* (
        requestID: ImageRequestID,
        status: Status,
        prompt?: string,
      ) {
        const pending = (yield* InstanceState.get(state)).pending
        const existing = pending.get(requestID)
        if (!existing) {
          log.warn("resolve for unknown request", { requestID, status })
          return
        }
        pending.delete(requestID)
        log.info("resolved", { requestID, status })
        Bus.publish(Event.Resolved, { sessionID: existing.info.sessionID, requestID: existing.info.id, status })
        yield* Deferred.succeed(existing.deferred, { status, prompt: prompt?.trim() || existing.info.prompt })
      })

      const approve = Effect.fn("ImageRequest.approve")(function* (input: {
        requestID: ImageRequestID
        prompt?: string
      }) {
        yield* resolve(input.requestID, "approved", input.prompt)
      })

      const skip = Effect.fn("ImageRequest.skip")(function* (requestID: ImageRequestID) {
        yield* resolve(requestID, "skipped")
      })

      const reject = Effect.fn("ImageRequest.reject")(function* (requestID: ImageRequestID) {
        yield* resolve(requestID, "canceled")
      })

      const list = Effect.fn("ImageRequest.list")(function* () {
        const pending = (yield* InstanceState.get(state)).pending
        return Array.from(pending.values(), (x) => x.info)
      })

      return Service.of({ ask, approve, skip, reject, list })
    }),
  )

  const { runPromise } = makeRuntime(Service, layer)

  export async function ask(input: {
    sessionID: SessionID
    info: Info
    tool?: { messageID: MessageID; callID: string }
  }): Promise<Result> {
    return runPromise((s) => s.ask(input))
  }

  export async function approve(input: { requestID: ImageRequestID; prompt?: string }) {
    return runPromise((s) => s.approve(input))
  }

  export async function skip(requestID: ImageRequestID) {
    return runPromise((s) => s.skip(requestID))
  }

  export async function reject(requestID: ImageRequestID) {
    return runPromise((s) => s.reject(requestID))
  }

  export async function list() {
    return runPromise((s) => s.list())
  }
}
