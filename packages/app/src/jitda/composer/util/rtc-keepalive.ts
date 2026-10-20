// Loopback WebRTC keepalive — two RTCPeerConnections wired to each other inside the same page,
// holding one open RTCDataChannel. Chromium exempts a page with an open RTCDataChannel from the
// interventions that kill a backgrounded collaboration tab's JS:
//   - Energy Saver tab freezing (Chrome 133+): frozen tabs stop the event loop entirely, so the
//     submit-socket heartbeat pong stops and the participant is reaped as 나감 within seconds.
//   - Intensive timer throttling (Chrome 88+): background timers drop to one tick per MINUTE after
//     5 minutes hidden; with an open channel they stay at 1s. (Measured: maxGap 60s → 2s.)
//   - Memory Saver tab discard.
// Kept on for the whole collaborative doc session, NOT toggled by visibility or participant count:
// a frozen tab cannot re-enable itself when someone joins later, and window-occlusion (another app
// fully covering the browser) flips the internal hidden state without a reliable visibilitychange
// on every platform — so any "turn it on when needed" scheme has an unrecoverable race.
export function startRtcKeepalive(): () => void {
  let stopped = false
  let a: RTCPeerConnection | undefined
  let b: RTCPeerConnection | undefined
  let channel: RTCDataChannel | undefined
  let watchdog: ReturnType<typeof setInterval> | undefined

  const teardown = () => {
    try {
      channel?.close()
    } catch {}
    try {
      a?.close()
    } catch {}
    try {
      b?.close()
    } catch {}
    channel = undefined
    a = undefined
    b = undefined
  }

  const connect = async () => {
    if (stopped) return
    teardown()
    try {
      a = new RTCPeerConnection()
      b = new RTCPeerConnection()
      channel = a.createDataChannel("keepalive")
      b.ondatachannel = (event) => {
        event.channel.onmessage = () => {}
      }
      a.onicecandidate = (event) => {
        if (event.candidate) void b?.addIceCandidate(event.candidate).catch(() => {})
      }
      b.onicecandidate = (event) => {
        if (event.candidate) void a?.addIceCandidate(event.candidate).catch(() => {})
      }
      const offer = await a.createOffer()
      await a.setLocalDescription(offer)
      await b.setRemoteDescription(offer)
      const answer = await b.createAnswer()
      await b.setLocalDescription(answer)
      await a.setRemoteDescription(answer)
    } catch {
      // WebRTC unavailable (or negotiation failed): the watchdog below retries; if the platform
      // simply lacks RTCPeerConnection the page just doesn't get the exemption — no other harm.
      teardown()
    }
  }

  void connect()
  // The exemption requires the channel to be OPEN — a silently dead pair would leave the tab
  // freezable again, so periodically ping and rebuild if the channel ever drops.
  watchdog = setInterval(() => {
    if (stopped) return
    if (channel?.readyState === "open") {
      try {
        channel.send("ping")
      } catch {}
      return
    }
    if (!channel || channel.readyState === "closed" || channel.readyState === "closing") void connect()
  }, 10_000)

  return () => {
    stopped = true
    if (watchdog) clearInterval(watchdog)
    teardown()
  }
}
