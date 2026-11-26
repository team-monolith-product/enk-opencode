import type { QuestionPresenceEntry } from "@/components/prompt-input/doc-submit"

export type QuestionConsensusInput = {
  consentRequired: boolean
  self?: string
  tab: number
  presence: QuestionPresenceEntry[]
  mine: string[]
  mineCustomOn: boolean
  customText: string
}

const selectionKey = (selection: string[]) => [...selection].sort().join("\u0000")

export function questionConsensus(input: QuestionConsensusInput) {
  if (!input.consentRequired) return input.mine.length > 0
  const self = input.self
  const here = input.presence.filter(
    (item) => item.qIndex === input.tab && (item.actorID === self || !item.autoConsent),
  )
  // A participant who selected the custom option but left the (shared) text empty has an INCOMPLETE
  // selection — visually marked as selected but not yet a real answer. Since the text is shared, an
  // empty text means EVERY custom-on participant is incomplete, so the gate can never be unanimous:
  // block until text is entered or custom is deselected.
  const text = input.customText.trim()
  const effective = (selection: string[], customOn: boolean) =>
    customOn && text ? [...selection, input.customText] : selection
  const missingSelf = !!self && !here.some((item) => item.actorID === self)
  const customOn = here.map((item) => (item.actorID === self ? input.mineCustomOn : item.customFocused))
  if (missingSelf) customOn.push(input.mineCustomOn)
  if (!text && customOn.some(Boolean)) return false
  const selections = here.map((item) =>
    item.actorID === self ? input.mine : effective(item.selection, item.customFocused),
  )
  if (missingSelf) selections.push(input.mine)
  if (selections.length === 0) return false
  const keys = selections.map(selectionKey)
  if (keys.some((key) => key === "")) return false
  return keys.every((key) => key === keys[0])
}
