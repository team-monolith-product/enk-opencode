import { describe, expect, test } from "bun:test"
import type { QuestionPresenceEntry } from "@/components/prompt-input/doc-submit"
import { questionConsensus } from "./question-consensus"

const GA = "act_ga"
const NA = "act_na"

const entry = (actorID: string, selection: string[], extra: Partial<QuestionPresenceEntry> = {}) => ({
  actorID,
  name: actorID,
  color: "#000000",
  qIndex: 0,
  selection,
  customFocused: false,
  ...extra,
})

const base = { consentRequired: true, tab: 0, mineCustomOn: false, customText: "" }

describe("question consensus with auto-consent (dev E2E scenario 4)", () => {
  test("가 can submit 사과 while 나, on auto-consent, picked 바나나", () => {
    const presence = [entry(GA, ["사과"]), entry(NA, ["바나나"], { autoConsent: true })]
    expect(questionConsensus({ ...base, self: GA, presence, mine: ["사과"] })).toBe(true)
  })

  test("the gate closes again once 나 turns auto-consent off with a different pick", () => {
    const presence = [entry(GA, ["사과"]), entry(NA, ["바나나"])]
    expect(questionConsensus({ ...base, self: GA, presence, mine: ["사과"] })).toBe(false)
  })

  test("with auto-consent off the gate opens only when both pick the same answer", () => {
    const presence = [entry(GA, ["사과"]), entry(NA, ["사과"])]
    expect(questionConsensus({ ...base, self: GA, presence, mine: ["사과"] })).toBe(true)
  })

  test("my own pick always counts even when I am on auto-consent", () => {
    const presence = [entry(GA, ["사과"]), entry(NA, ["바나나"], { autoConsent: true })]
    expect(questionConsensus({ ...base, self: NA, presence, mine: ["바나나"] })).toBe(false)
  })

  test("an auto-consent teammate who has not picked anything does not block", () => {
    const presence = [entry(GA, ["사과"]), entry(NA, [], { autoConsent: true })]
    expect(questionConsensus({ ...base, self: GA, presence, mine: ["사과"] })).toBe(true)
  })

  test("an auto-consent teammate with an empty custom answer does not block", () => {
    const presence = [entry(GA, ["사과"]), entry(NA, [], { autoConsent: true, customFocused: true })]
    expect(questionConsensus({ ...base, self: GA, presence, mine: ["사과"] })).toBe(true)
  })

  test("I still need to pick something when every teammate is on auto-consent", () => {
    const presence = [entry(GA, []), entry(NA, ["바나나"], { autoConsent: true })]
    expect(questionConsensus({ ...base, self: GA, presence, mine: [] })).toBe(false)
  })

  test("teammates on another question are ignored", () => {
    const presence = [entry(GA, ["사과"]), entry(NA, ["바나나"], { qIndex: 1 })]
    expect(questionConsensus({ ...base, self: GA, presence, mine: ["사과"] })).toBe(true)
  })

  test("with team consent turned off only my own answer matters", () => {
    const presence = [entry(GA, ["사과"]), entry(NA, ["바나나"])]
    expect(questionConsensus({ ...base, consentRequired: false, self: GA, presence, mine: ["사과"] })).toBe(true)
  })
})
