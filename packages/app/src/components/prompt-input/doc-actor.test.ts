import { describe, expect, test } from "bun:test"
import { loadAutoConsent, saveAutoConsent, toggleAutoConsent } from "./doc-actor"

function deferred() {
  let resolve!: (value: boolean) => void
  let reject!: (error: Error) => void
  const promise = new Promise<boolean>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("auto-consent switch", () => {
  test("switching on then off quickly ends off even when the first reply arrives last", async () => {
    saveAutoConsent(false, "737")
    const on = deferred()
    const off = deferred()
    const first = toggleAutoConsent("737", () => on.promise)
    expect(loadAutoConsent("737")).toBe(true)
    const second = toggleAutoConsent("737", () => off.promise)
    expect(loadAutoConsent("737")).toBe(false)

    off.resolve(false)
    await second
    on.resolve(true)
    await first

    expect(loadAutoConsent("737")).toBe(false)
  })

  test("a failed request puts the switch back", async () => {
    saveAutoConsent(false, "737")
    const call = deferred()
    const done = toggleAutoConsent("737", () => call.promise)
    expect(loadAutoConsent("737")).toBe(true)
    call.reject(new Error("offline"))
    await done
    expect(loadAutoConsent("737")).toBe(false)
  })

  test("the switch follows what the server returns", async () => {
    saveAutoConsent(false, "737")
    await toggleAutoConsent("737", async () => false)
    expect(loadAutoConsent("737")).toBe(false)
  })

  test("each person keeps their own value", async () => {
    saveAutoConsent(false, "736")
    saveAutoConsent(false, "737")
    await toggleAutoConsent("737", async (next) => next)
    expect(loadAutoConsent("737")).toBe(true)
    expect(loadAutoConsent("736")).toBe(false)
  })
})
