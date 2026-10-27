const writeWithClipboardAPI = (value: string) => {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return Promise.resolve(false)
  return clipboard.writeText(value).then(
    () => true,
    () => false,
  )
}

const writeWithSelection = (value: string) => {
  if (typeof document === "undefined" || !document.body) return false

  const restore = document.activeElement
  const host = restore instanceof HTMLElement ? restore.closest<HTMLElement>('[role="menu"],[role="dialog"]') : null
  const body = host ?? document.body
  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  textarea.style.pointerEvents = "none"
  body.appendChild(textarea)
  // Focusing pulls focus out of whatever iframe holds it and into this document, which is
  // what makes the copy land. Do it explicitly rather than leaning on select() to do it.
  textarea.focus()
  textarea.select()

  let copied = false
  try {
    copied = document.execCommand("copy")
  } catch {
    copied = false
  }

  textarea.remove()
  if (restore instanceof HTMLElement) restore.focus()
  return copied
}

/**
 * The Clipboard API rejects with NotAllowedError when the document is not focused, which
 * happens whenever focus sits inside a cross-origin iframe such as the preview pane. The
 * selection fallback pulls focus back into this document, so it still copies.
 *
 * Never rejects — returns whether the value made it to the clipboard.
 */
export const writeClipboard = async (value: string): Promise<boolean> => {
  if (await writeWithClipboardAPI(value)) return true
  return writeWithSelection(value)
}
