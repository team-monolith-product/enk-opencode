import { describe, expect, test } from "bun:test"
import type { DevServerStatusResult } from "@/utils/server"
import { needsReachabilityProbe, resolvePreviewState } from "./session-preview-state"

describe("needsReachabilityProbe", () => {
  test("probes only the ambiguous not-up states (none, startable)", () => {
    expect(needsReachabilityProbe({ state: "none" })).toBe(true)
    expect(needsReachabilityProbe({ state: "startable", port: 3000 })).toBe(true)
  })

  test("does not probe errored — the server's HTTP self-probe is authoritative", () => {
    expect(needsReachabilityProbe({ state: "errored", port: 3000, httpStatus: 502 })).toBe(false)
  })

  test("does not probe ready or starting", () => {
    expect(needsReachabilityProbe({ state: "ready", port: 3000 })).toBe(false)
    expect(needsReachabilityProbe({ state: "starting" })).toBe(false)
  })

  test("does not probe a missing server verdict", () => {
    expect(needsReachabilityProbe(undefined)).toBe(false)
  })
})

describe("resolvePreviewState", () => {
  const cases: Array<[DevServerStatusResult["state"]]> = [["ready"], ["starting"]]
  for (const [state] of cases) {
    test(`passes ${state} through untouched regardless of reachability`, () => {
      const server: DevServerStatusResult = { state, port: 3000 }
      expect(resolvePreviewState(server, true)).toEqual(server)
      expect(resolvePreviewState(server, false)).toEqual(server)
    })
  }

  test("treats a missing server verdict as starting (keep polling, don't blank out)", () => {
    expect(resolvePreviewState(undefined, false)).toEqual({ state: "starting" })
    expect(resolvePreviewState(undefined, true)).toEqual({ state: "starting" })
  })

  test("never upgrades errored — the errored fallback (retry + AI-fix) must stay reachable", () => {
    const errored: DevServerStatusResult = { state: "errored", port: 3000, httpStatus: 503 }
    expect(resolvePreviewState(errored, true)).toEqual(errored)
    expect(resolvePreviewState(errored, false)).toEqual(errored)
  })

  test("carries loopbackOnly through untouched — only the server can make that call", () => {
    // 루프백 전용 바인드(--host 0.0.0.0 누락). 클라의 cors 프로브는 CORS 헤더 없는 정상 서버에서도
    // throw 하므로 여기서 reachable 을 믿고 ready 로 올리면 안 되고, 플래그도 잃으면 안 된다.
    const loopbackOnly: DevServerStatusResult = { state: "errored", port: 3000, loopbackOnly: true }
    expect(resolvePreviewState(loopbackOnly, true)).toEqual(loopbackOnly)
    expect(resolvePreviewState(loopbackOnly, false)).toEqual(loopbackOnly)
    expect(needsReachabilityProbe(loopbackOnly)).toBe(false)
  })

  test("upgrades startable to ready only when the client can actually reach the preview", () => {
    const startable: DevServerStatusResult = { state: "startable", port: 4321 }
    expect(resolvePreviewState(startable, true)).toEqual({ state: "ready", port: 4321 })
    // Unreachable (down): keep startable so the fallback UI shows and auto-retry-once can fire.
    expect(resolvePreviewState(startable, false)).toEqual(startable)
  })

  test("upgrades none to ready when reachable, else keeps none", () => {
    const none: DevServerStatusResult = { state: "none" }
    expect(resolvePreviewState(none, true)).toEqual({ state: "ready", port: undefined })
    expect(resolvePreviewState(none, false)).toEqual(none)
  })
})
