/** A selection entry as the editor reports it — the two fields that decide whether it still points
 *  at something real. */
export type SelectionRef = { type: string; blockId?: string }

export type SelectionRepair<T> = {
  /** Entries that still point at a live block. */
  keep: T[]
  /** Set only when nothing survives: the block a caret should land in instead. */
  caret?: string
}

/**
 * What the editor's selection should become after a block was deleted.
 *
 * BlockSuite resolves a selection's block by id on every keystroke and does nothing at all when the
 * lookup misses. So a selection left pointing at a deleted block silently kills the keyboard —
 * Backspace above all — and stays that way until the page is reloaded, which is exactly the
 * "the last attachment will not delete, but a refresh fixes it" report this guards against.
 *
 * A delete normally moves the selection itself; the ones that matter here are the deletes whose
 * follow-up never ran (a render that threw mid-update). Returns undefined while every entry is
 * still valid, so ordinary editing — where a delete fires on every backspace — stays quiet.
 */
export function repairSelection<T extends SelectionRef>(
  current: readonly T[],
  alive: (blockId: string) => boolean,
  fallback: () => string | undefined,
): SelectionRepair<T> | undefined {
  // An entry without a blockId (a surface/native selection) is nobody's dangling reference.
  const keep = current.filter((item) => !item.blockId || alive(item.blockId))
  if (keep.length === current.length) return undefined
  if (keep.length > 0) return { keep }
  const caret = fallback()
  return caret ? { keep, caret } : { keep }
}
