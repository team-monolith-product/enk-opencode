import { describe, expect, test } from "bun:test"
import { connectUrlFor } from "./connect-url"

const jitda = "https://dev.jitda.io/auth/github?team_id=7"

describe("connectUrlFor", () => {
  test("keeps the url when there is no embedding site", () => {
    expect(connectUrlFor(jitda, undefined)).toBe(jitda)
  })

  test("keeps the url when embedded by the same site", () => {
    expect(connectUrlFor(jitda, "https://dev.jitda.io")).toBe(jitda)
  })

  test("moves the url to bana.build when embedded there", () => {
    expect(connectUrlFor(jitda, "https://bana.build")).toBe("https://bana.build/auth/github?team_id=7")
    expect(connectUrlFor(jitda, "https://dev.bana.build")).toBe("https://dev.bana.build/auth/github?team_id=7")
  })

  test("ignores embedders that only look like bana.build", () => {
    expect(connectUrlFor(jitda, "https://bana.build.evil.com")).toBe(jitda)
    expect(connectUrlFor(jitda, "https://notbana.build")).toBe(jitda)
  })
})
