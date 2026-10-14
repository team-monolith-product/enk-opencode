import { describe, expect, test } from "bun:test"
import { bridgeResult } from "./initial-plan-bridge"

describe("bridgeResult", () => {
  test("passes every delivery state through", () => {
    for (const state of ["delivered", "already_delivered", "not_finalized", "pending_elsewhere", "failed"])
      expect(bridgeResult(200, { state })).toEqual({ status: "ok", payload: { state } } as never)
  })

  test("reports the server error", () => {
    expect(bridgeResult(502, { error: "model unavailable" })).toEqual({ status: "failed", error: "model unavailable" })
    expect(bridgeResult(503, { error: "rails is not configured" })).toEqual({
      status: "failed",
      error: "rails is not configured",
    })
  })

  test("never reports success for an unknown or missing state", () => {
    expect(bridgeResult(200, { state: "weird" })).toEqual({ status: "failed", error: "HTTP 200" })
    expect(bridgeResult(500, undefined)).toEqual({ status: "failed", error: "HTTP 500" })
  })
})
