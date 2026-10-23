// V1 context/command 의 키 조합 해석. 제출·정지 키는 V1 설정 문자열("mod+enter")을 그대로 쓴다.
const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

export interface Keybind {
  key: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

export function parseKeybind(config: string): Keybind[] {
  if (!config || config === "none") return []

  return config.split(",").map((combo) => {
    const parts = combo.trim().toLowerCase().split("+")
    const keybind: Keybind = { key: "", ctrl: false, meta: false, shift: false, alt: false }

    for (const part of parts) {
      switch (part) {
        case "ctrl":
        case "control":
          keybind.ctrl = true
          break
        case "meta":
        case "cmd":
        case "command":
          keybind.meta = true
          break
        case "mod":
          if (IS_MAC) keybind.meta = true
          else keybind.ctrl = true
          break
        case "alt":
        case "option":
          keybind.alt = true
          break
        case "shift":
          keybind.shift = true
          break
        default:
          keybind.key = part
          break
      }
    }

    return keybind
  })
}

export function matchKeybind(keybinds: Keybind[], event: KeyboardEvent): boolean {
  const eventKey = normalizeKey(event.key)
  return keybinds.some(
    (kb) =>
      kb.key === eventKey &&
      kb.ctrl === (event.ctrlKey || false) &&
      kb.meta === (event.metaKey || false) &&
      kb.shift === (event.shiftKey || false) &&
      kb.alt === (event.altKey || false),
  )
}

type KeyLabel =
  | "common.key.ctrl"
  | "common.key.alt"
  | "common.key.shift"
  | "common.key.meta"
  | "common.key.enter"
  | "common.key.esc"

const fallback: Record<KeyLabel, string> = {
  "common.key.ctrl": "Ctrl",
  "common.key.alt": "Alt",
  "common.key.shift": "Shift",
  "common.key.meta": "Meta",
  "common.key.enter": "Enter",
  "common.key.esc": "Esc",
}

export function formatKeybind(config: string, t?: (key: KeyLabel) => string): string {
  const kb = parseKeybind(config)[0]
  if (!kb) return ""
  const text = (key: KeyLabel) => (t ? t(key) : fallback[key])
  const parts: string[] = []

  if (kb.ctrl) parts.push(IS_MAC ? "⌃" : text("common.key.ctrl"))
  if (kb.alt) parts.push(IS_MAC ? "⌥" : text("common.key.alt"))
  if (kb.shift) parts.push(IS_MAC ? "⇧" : text("common.key.shift"))
  if (kb.meta) parts.push(IS_MAC ? "⌘" : text("common.key.meta"))

  if (kb.key) {
    const keys: Record<string, string> = {
      arrowup: "↑",
      arrowdown: "↓",
      arrowleft: "←",
      arrowright: "→",
      comma: ",",
      plus: "+",
    }
    const named: Record<string, KeyLabel> = {
      enter: "common.key.enter",
      esc: "common.key.esc",
      escape: "common.key.esc",
    }
    const key = kb.key.toLowerCase()
    parts.push(
      keys[key] ??
        (named[key]
          ? text(named[key])
          : key.length === 1
            ? key.toUpperCase()
            : key.charAt(0).toUpperCase() + key.slice(1)),
    )
  }

  return IS_MAC ? parts.join("") : parts.join("+")
}
