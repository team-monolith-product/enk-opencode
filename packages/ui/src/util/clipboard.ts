const writeWithClipboardAPI = (value: string) => {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return Promise.resolve(false)
  return clipboard.writeText(value).then(
    () => true,
    () => false,
  )
}

const writeWithSelection = (value: string) => {
  const body = typeof document === "undefined" ? undefined : document.body
  if (!body) return false

  const restore = document.activeElement
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

  body.removeChild(textarea)
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
