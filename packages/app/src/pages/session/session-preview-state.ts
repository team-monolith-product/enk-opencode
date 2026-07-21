import type { DevServerStatusResult } from "@/utils/server"

// Whether the client should consult its own cross-origin reachability probe for a given server verdict.
// The server self-probes 127.0.0.1:PORT (loopback inside the pod), which can disagree with what the
// client reaches via CHP routing — but only for the "server says not-up" ambiguous states:
//   - none / startable: loopback sees no server, yet CHP may still route to one → worth probing.
//   - errored: the server got an authoritative HTTP >=500 from its own probe. The client's opaque
//     cross-origin fetch can't do better, and upgrading it to "ready" would hide the errored fallback
//     (its retry button + AI-fix prompt). Trust the server here — do NOT probe.
//   - ready / starting: no probe needed (ready shows the iframe; starting keeps polling).
export function needsReachabilityProbe(server: DevServerStatusResult | undefined): boolean {
  return !!server && (server.state === "none" || server.state === "startable")
}

// Resolve the state the panel should render from the server verdict plus the client reachability signal.
// `reachable` is only meaningful when needsReachabilityProbe(server) is true; callers pass false otherwise.
//
// The upgrade-to-ready escape hatch exists because the server's loopback probe can miss a dev server the
// client reaches through CHP. It applies ONLY to none/startable, and only on a positive reach — so a
// genuinely down server (probe returns false) keeps its startable/none state, which is what drives the
// fallback UI and the auto-retry-once. errored is never overridden (see needsReachabilityProbe).
export function resolvePreviewState(
  server: DevServerStatusResult | undefined,
  reachable: boolean,
): DevServerStatusResult {
  if (!server || server.state === "starting" || server.state === "ready") return server ?? { state: "starting" }
  if (server.state === "errored") return server
  // none | startable
  return reachable ? { state: "ready", port: server.port } : server
}
