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

// iframe(미리보기) 에 포커스가 있으면 Clipboard API 가 거부되므로 selection 방식으로 한 번 더 시도한다.
export const writeClipboard = async (value: string): Promise<boolean> => {
  if (await writeWithClipboardAPI(value)) return true
  return writeWithSelection(value)
}
