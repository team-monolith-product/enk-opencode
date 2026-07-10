import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@/flag/flag"
import { SessionID } from "./schema"
import { Effect, Layer, ServiceMap } from "effect"

/**
 * Tracks how many times a session has fallen back to another model.
 *
 * Once the count reaches ENK_AI_FALLBACK_STICKY_AFTER the session is "degraded" and the
 * primary model stops getting retries — it still gets one attempt per turn, so a recovered
 * provider is picked back up (and resets the count), but a dead one only costs one failed
 * round trip per turn instead of the full retry budget.
 */
export namespace SessionFallback {
  export interface Interface {
    readonly count: (sessionID: SessionID) => Effect.Effect<number>
    readonly degraded: (sessionID: SessionID) => Effect.Effect<boolean>
    readonly increment: (sessionID: SessionID) => Effect.Effect<void>
    readonly reset: (sessionID: SessionID) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionFallback") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make(
        Effect.fn("SessionFallback.state")(() => Effect.succeed(new Map<SessionID, number>())),
      )

      const count = Effect.fn("SessionFallback.count")(function* (sessionID: SessionID) {
        const data = yield* InstanceState.get(state)
        return data.get(sessionID) ?? 0
      })

      const degraded = Effect.fn("SessionFallback.degraded")(function* (sessionID: SessionID) {
        return (yield* count(sessionID)) >= Flag.ENK_AI_FALLBACK_STICKY_AFTER
      })

      const increment = Effect.fn("SessionFallback.increment")(function* (sessionID: SessionID) {
        const data = yield* InstanceState.get(state)
        data.set(sessionID, (data.get(sessionID) ?? 0) + 1)
      })

      const reset = Effect.fn("SessionFallback.reset")(function* (sessionID: SessionID) {
        const data = yield* InstanceState.get(state)
        data.delete(sessionID)
      })

      return Service.of({ count, degraded, increment, reset })
    }),
  )
}
