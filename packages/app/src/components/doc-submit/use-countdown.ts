import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

// The submit socket retries every RECONNECT_MS (see connectSubmit in prompt-input/doc-submit.ts), so a
// terminal cast (sent/expired/cancelled) missed while the socket was down arrives, at worst, one
// reconnect cycle late via the server's replay-on-connect. Keep this in sync if that interval changes.
const RECONNECT_MS = 500
// The client fallback fires this long AFTER the nominal deadline so the server's own terminal cast —
// the source of truth — gets first say (one reconnect cycle + margin). It only kicks in when that cast
// never arrives (socket drop, throttled tab, clock skew): the "finished vote stays on screen" bug.
const EXPIRE_GRACE_MS = RECONNECT_MS + 250

export function useCountdown(expiresAt: Accessor<number | undefined>, onExpire?: () => void) {
  const [remaining, setRemaining] = createSignal(0)

  createEffect(() => {
    const expires = expiresAt()
    if (!expires) return

    let raf: number | undefined
    const tick = () => {
      setRemaining(Math.max(0, (expires - Date.now()) / 1000))
      if (expires - Date.now() > 0) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    // Deadline-anchored one-shot: independent of the RAF loop (which a backgrounded tab pauses) so the
    // local expiry still fires when the tab resumes. Cleared if the vote resolves or a new vote starts.
    let timer: ReturnType<typeof setTimeout> | undefined
    if (onExpire) timer = setTimeout(onExpire, Math.max(0, expires - Date.now()) + EXPIRE_GRACE_MS)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  return remaining
}
