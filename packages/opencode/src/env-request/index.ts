import { Deferred, Effect, Layer, ServiceMap } from "effect"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { SessionID, MessageID } from "@/session/schema"
import { EnvFile } from "@/util/env-file"
import { Log } from "@/util/log"
import { EnvRequestID } from "./schema"

// AI 가 앱에 필요한 외부 서비스 값을 참가자에게 요청하는 흐름. Question 서비스와 같은 구조지만
// 결정적으로 다른 점이 하나 있다 — 값은 이 네임스페이스 밖으로 절대 나가지 않는다.
//
//   AI  → ask()           이름·표시명만 넘긴다. 값은 파라미터에 아예 없다
//   UI  → submit(value)   값을 받아 그 자리에서 .env 로 쓰고 버린다
//   AI  ← status          "저장됨/건너뜀/취소됨"만 돌려받는다
//
// 그래서 Request 스키마에도, Resolved 이벤트에도 값 필드가 없다. 실수로 실릴 자리를 만들지 않는 게
// 이 설계의 핵심이다. 로그에도 값을 찍지 않는다.
export namespace EnvRequest {
  const log = Log.create({ service: "env-request" })

  // Schemas

  export const Info = z
    .object({
      name: z
        .string()
        .regex(EnvFile.KEY_REGEX)
        .max(256)
        .describe("Environment variable name the app reads (UPPER_SNAKE_CASE)"),
      label: z.string().max(120).describe("Service name shown to the user, in their language"),
      reason: z.string().max(500).optional().describe("Why this value is needed, in the user's language"),
      docsUrl: z.string().max(500).optional().describe("Where the user can obtain the value"),
      replace: z
        .boolean()
        .optional()
        .describe("Ask again even though a value is already stored, so the user can replace it"),
    })
    .meta({ ref: "EnvRequestInfo" })
  export type Info = z.infer<typeof Info>

  export const Request = Info.extend({
    id: EnvRequestID.zod,
    sessionID: SessionID.zod,
    tool: z
      .object({
        messageID: MessageID.zod,
        callID: z.string(),
      })
      .optional(),
  }).meta({ ref: "EnvRequest" })
  export type Request = z.infer<typeof Request>

  export const Status = z.enum(["saved", "skipped", "canceled"]).meta({ ref: "EnvRequestStatus" })
  export type Status = z.infer<typeof Status>

  /** ask() 의 결과. 참가자가 이름을 고쳤을 수 있어 확정된 이름을 함께 돌려준다. */
  export type Result = { status: Status; name: string }

  export const Event = {
    Asked: BusEvent.define("env.request.asked", Request),
    Resolved: BusEvent.define(
      "env.request.resolved",
      z.object({
        sessionID: SessionID.zod,
        requestID: EnvRequestID.zod,
        name: z.string(),
        status: Status,
      }),
    ),
  }

  interface PendingEntry {
    info: Request
    deferred: Deferred.Deferred<Result>
  }

  interface State {
    pending: Map<EnvRequestID, PendingEntry>
  }

  // Service

  export interface Interface {
    readonly ask: (input: {
      sessionID: SessionID
      info: Info
      tool?: { messageID: MessageID; callID: string }
    }) => Effect.Effect<Result>
    /** 값을 받아 .env 에 쓰고 요청을 닫는다. 값은 이 호출 안에서만 존재한다. */
    readonly submit: (input: {
      requestID: EnvRequestID
      file: string
      value: string
      /** 참가자가 이름을 고쳤을 때만 온다. 없으면 AI 가 정한 이름을 그대로 쓴다. */
      name?: string
    }) => Effect.Effect<void>
    readonly skip: (requestID: EnvRequestID) => Effect.Effect<void>
    readonly reject: (requestID: EnvRequestID) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Request[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/EnvRequest") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make<State>(
        Effect.fn("EnvRequest.state")(function* () {
          const state = {
            pending: new Map<EnvRequestID, PendingEntry>(),
          }

          // 인스턴스가 내려갈 때 대기 중인 요청을 전부 풀어준다. 안 그러면 툴 호출이 영원히 매달린다.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const item of state.pending.values()) {
                yield* Deferred.succeed(item.deferred, { status: "canceled" as Status, name: item.info.name })
              }
              state.pending.clear()
            }),
          )

          return state
        }),
      )

      const ask = Effect.fn("EnvRequest.ask")(function* (input: {
        sessionID: SessionID
        info: Info
        tool?: { messageID: MessageID; callID: string }
      }) {
        const pending = (yield* InstanceState.get(state)).pending
        const id = EnvRequestID.ascending()
        log.info("asking", { id, name: input.info.name })

        const deferred = yield* Deferred.make<Result>()
        const info: Request = {
          ...input.info,
          id,
          sessionID: input.sessionID,
          tool: input.tool,
        }
        pending.set(id, { info, deferred })
        Bus.publish(Event.Asked, info)

        return yield* Effect.ensuring(
          Deferred.await(deferred),
          Effect.sync(() => {
            pending.delete(id)
          }),
        )
      })

      const resolve = Effect.fn("EnvRequest.resolve")(function* (requestID: EnvRequestID, status: Status) {
        const pending = (yield* InstanceState.get(state)).pending
        const existing = pending.get(requestID)
        if (!existing) {
          log.warn("resolve for unknown request", { requestID, status })
          return
        }
        pending.delete(requestID)
        log.info("resolved", { requestID, status })
        Bus.publish(Event.Resolved, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          name: existing.info.name,
          status,
        })
        yield* Deferred.succeed(existing.deferred, { status, name: existing.info.name })
        return existing
      })

      const submit = Effect.fn("EnvRequest.submit")(function* (input: {
        requestID: EnvRequestID
        file: string
        value: string
        name?: string
      }) {
        const pending = (yield* InstanceState.get(state)).pending
        const existing = pending.get(input.requestID)
        if (!existing) {
          log.warn("submit for unknown request", { requestID: input.requestID })
          return
        }
        // 참가자가 이름을 고쳤으면 그쪽이 확정이다 — 앱이 읽을 이름을 정하는 건 결국 사람이다.
        if (input.name) existing.info.name = input.name
        // 쓰기가 실패하면 요청을 열어 둔 채로 던진다 — 저장 못 한 걸 "저장됨"으로 알리지 않는다.
        yield* Effect.promise(() => EnvFile.set(input.file, { [existing.info.name]: input.value }))
        yield* resolve(input.requestID, "saved")
      })

      const skip = Effect.fn("EnvRequest.skip")(function* (requestID: EnvRequestID) {
        yield* resolve(requestID, "skipped")
      })

      const reject = Effect.fn("EnvRequest.reject")(function* (requestID: EnvRequestID) {
        yield* resolve(requestID, "canceled")
      })

      const list = Effect.fn("EnvRequest.list")(function* () {
        const pending = (yield* InstanceState.get(state)).pending
        return Array.from(pending.values(), (x) => x.info)
      })

      return Service.of({ ask, submit, skip, reject, list })
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

  export async function submit(input: { requestID: EnvRequestID; file: string; value: string; name?: string }) {
    return runPromise((s) => s.submit(input))
  }

  export async function skip(requestID: EnvRequestID) {
    return runPromise((s) => s.skip(requestID))
  }

  export async function reject(requestID: EnvRequestID) {
    return runPromise((s) => s.reject(requestID))
  }

  export async function list() {
    return runPromise((s) => s.list())
  }
}
