import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { FileDiff } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

// The enk-opencode-hub CHP proxy is configured with
//   --serve-domain=<domain> --serve-port=<PREVIEW_DEV_PORT>
// Requests to {username}.{serveDomain} are forwarded to port
// PREVIEW_DEV_PORT inside the singleuser pod. Dev servers MUST bind
// to 0.0.0.0:<PREVIEW_DEV_PORT> to be reachable.
const PREVIEW_DEV_PORT = 3000
const VITE_CONFIG_PATTERN = /(^|\/)vite\.config\.(ts|tsx|js|cjs|mjs|jsx)$/i
const NEXT_CONFIG_PATTERN = /(^|\/)next\.config\.(ts|tsx|js|cjs|mjs|jsx)$/i
const PREVIEW_FILE_PATTERN = /\.(html|htm|pdf|svg)$/i
const PREVIEW_PTY_TITLE = "__opencode_preview_dev_server__"
const PREVIEW_INSTALL_LOG = "/tmp/opencode-preview-install.log"
// How long to wait for the dev server to become reachable after spawn.
const PREVIEW_READY_TIMEOUT_MS = 60_000
const PREVIEW_READY_INTERVAL_MS = 500

type Framework = "vite" | "next"

const detectFramework = (paths: string[]): Framework | undefined => {
  if (paths.some((p) => VITE_CONFIG_PATTERN.test(p))) return "vite"
  if (paths.some((p) => NEXT_CONFIG_PATTERN.test(p))) return "next"
  return undefined
}

const findPreviewable = (paths: string[]) => {
  const framework = detectFramework(paths)
  if (framework) return { type: "devserver" as const, framework }
  const file = paths.find((p) => PREVIEW_FILE_PATTERN.test(p))
  if (file) return { type: "file" as const, path: file }
  return undefined
}

const devServerShellScript = (framework: Framework) => {
  // Detect package manager from lock file so we don't clobber an
  // existing lockfile with a mismatched installer (e.g. `bun install`
  // in an npm-managed project creates bun.lock and may resolve
  // different versions). Falls back to bun when no lock file is found.
  const detectPm =
    "if [ -f bun.lock ] || [ -f bun.lockb ]; then PM=bun; " +
    "elif [ -f pnpm-lock.yaml ]; then PM=pnpm; " +
    "elif [ -f yarn.lock ]; then PM=yarn; " +
    "elif [ -f package-lock.json ]; then PM=npm; " +
    "else PM=bun; fi"
  // Only install when node_modules is missing — re-installing on every
  // spawn would be both slow and a vector for lockfile drift.
  const maybeInstall = `[ -d node_modules ] || "$PM" install >${PREVIEW_INSTALL_LOG} 2>&1`
  // `<pm> run dev --` forwards extra flags to the underlying dev script.
  // Flags must make the server bind to 0.0.0.0:<PREVIEW_DEV_PORT> to
  // be reachable by the CHP proxy.
  const hostFlag = framework === "vite" ? "--host" : "--hostname"
  // Vite 5.4.12+ (CVE-2025-24010) rejects requests whose Host header
  // isn't in server.allowedHosts. Passing the flag with no value sets
  // it to `true` (allow all); safe here because the CHP proxy and
  // JupyterHub auth already isolate the dev server per user.
  // Next.js: no CLI equivalent; needs allowedDevOrigins in next.config
  // (follow-up).
  const extraFlags = framework === "vite" ? " --allowedHosts" : ""
  const run = `"$PM" run dev -- ${hostFlag} 0.0.0.0 --port ${PREVIEW_DEV_PORT}${extraFlags}`
  return `${detectPm}; ${maybeInstall}; ${run}`
}

// Poll until the dev server answers with a non-5xx response, or the
// timeout elapses. Cross-origin GET — the CHP proxy adds
// Access-Control-Allow-Origin: * for serve domain responses.
// Returns true on ready, false on timeout / stale / network failing.
const waitForDevServer = async (url: string, isStale: () => boolean) => {
  const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (isStale()) return false
    try {
      const res = await fetch(url, { cache: "no-store", mode: "cors" })
      if (res.status < 500) return true
    } catch {
      // Connection refused, network error, or CORS error — dev server not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_READY_INTERVAL_MS))
  }
  return false
}

export function createPreview(input: {
  diffs: Accessor<FileDiff[]>
  hasReview: Accessor<boolean>
}) {
  const sdk = useSDK()
  const sync = useSync()

  // Returns undefined when the server does not expose serveDomain and
  // jupyterhubUser (e.g. local dev against a bare opencode server).
  const devServerUrl = () => {
    const path = sync.data.path
    const domain = path?.serveDomain
    const user = path?.jupyterhubUser
    if (!domain || !user) return undefined
    return `https://${user}.${domain}`
  }

  const ensureDevServerPty = async (framework: Framework) => {
    const list = await sdk.client.pty.list({}).catch((error: unknown) => {
      console.error("[preview] failed to list PTYs", error)
      return undefined
    })
    const running = list?.data?.find((p) => p.title === PREVIEW_PTY_TITLE && p.status === "running")
    if (running) {
      // If the existing PTY was spawned before the `--allowedHosts` fix,
      // Vite will still reject proxied requests. Detect that by looking
      // at the shell script embedded in args[1] and respawn if stale.
      const shellScript = running.args[1] ?? ""
      const hasAllowedHosts = shellScript.includes("--allowedHosts")
      if (framework !== "vite" || hasAllowedHosts) return running
      await sdk.client.pty.remove({ ptyID: running.id }).catch((error: unknown) => {
        console.error("[preview] failed to remove stale PTY", error)
      })
    }
    return sdk.client.pty
      .create({
        title: PREVIEW_PTY_TITLE,
        command: "sh",
        args: ["-c", devServerShellScript(framework)],
      })
      .then((r) => r.data)
      .catch((error: unknown) => {
        console.error("[preview] failed to spawn dev server PTY", error)
        return undefined
      })
  }

  const [src, setSrc] = createSignal<string | undefined>()
  const [loading, setLoading] = createSignal(false)

  const revoke = () => {
    const prev = src()
    if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev)
  }

  onCleanup(revoke)

  const loadBlob = async (filePath: string): Promise<string | undefined> => {
    const data = await sdk.client.file
      .read({ path: filePath, preview: "true" })
      .then((res) => res.data)
      .catch(() => undefined)
    if (!data?.content) return undefined
    const blob =
      data.encoding === "base64"
        ? new Blob([Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0))], {
            type: data.mimeType || "application/octet-stream",
          })
        : new Blob([data.content], { type: data.mimeType || "text/html" })
    return URL.createObjectURL(blob)
  }

  let reqId = 0
  createEffect(() => {
    const diffList = input.diffs()
    const reviewable = input.hasReview()
    const myReq = ++reqId
    untrack(revoke)

    const isStale = () => myReq !== reqId
    const apply = (value: string | undefined) => {
      if (isStale()) return
      setLoading(false)
      setSrc(value)
    }

    if (!reviewable) {
      setLoading(false)
      setSrc(undefined)
      return
    }

    setLoading(true)
    setSrc(undefined)

    void (async () => {
      try {
        // Prefer diff list; fall back to file.status() when diffs haven't loaded yet
        // or the relevant files are untracked.
        let paths = diffList.filter((x) => x.status !== "deleted").map((x) => x.file)
        if (paths.length === 0) {
          paths = await sdk.client.file
            .status()
            .then((res) => (res.data ?? []).filter((f) => f.status !== "deleted").map((f) => f.path))
            .catch(() => [])
          if (isStale()) return
        }

        const target = findPreviewable(paths)
        if (!target) {
          apply(undefined)
          return
        }

        if (target.type === "devserver") {
          const url = devServerUrl()
          if (!url) {
            apply(undefined)
            return
          }
          const pty = await ensureDevServerPty(target.framework)
          if (isStale()) return
          if (!pty) {
            apply(undefined)
            return
          }
          const ready = await waitForDevServer(url, isStale)
          if (isStale()) return
          apply(ready ? url : undefined)
          return
        }

        const blobUrl = await loadBlob(target.path)
        if (isStale()) {
          if (blobUrl) URL.revokeObjectURL(blobUrl)
          return
        }
        apply(blobUrl)
      } catch (error) {
        console.error("[preview] effect failed", error)
        if (!isStale()) {
          setLoading(false)
          setSrc(undefined)
        }
      }
    })()
  })

  return { src, loading }
}
