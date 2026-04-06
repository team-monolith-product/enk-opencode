import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

export function SessionSidePanel(props: {
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const sdk = useSDK()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (reviewOpen()) return `calc(100% - ${layout.session.width()}px)`
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

  const reviewEmptyKey = createMemo(() => {
    if (sync.project && !sync.project.vcs) return "session.review.noVcs"
    if (sync.data.config.snapshot === false) return "session.review.noSnapshot"
    return "session.review.noChanges"
  })

  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  // The enk-opencode-hub CHP proxy is configured with
  //   --serve-path=/serve --serve-port=<PREVIEW_DEV_PORT>
  // so anything under /serve/... is forwarded to that port inside the
  // singleuser pod. Dev servers MUST bind to 0.0.0.0:<PREVIEW_DEV_PORT>
  // to be reachable. Keep PREVIEW_DEV_PORT in sync with the CHP config
  // in enk-opencode-hub-helm/aws-apne2-dev-hackathon.yaml.
  const PREVIEW_DEV_PORT = 3000
  const VITE_CONFIG_PATTERN = /(^|\/)vite\.config\.(ts|tsx|js|cjs|mjs|jsx)$/i
  const NEXT_CONFIG_PATTERN = /(^|\/)next\.config\.(ts|tsx|js|cjs|mjs|jsx)$/i
  const PREVIEW_FILE_PATTERN = /\.(html|htm|pdf|png|jpg|jpeg|gif|svg|webp)$/i
  const PREVIEW_PTY_TITLE = "__opencode_preview_dev_server__"
  const PREVIEW_INSTALL_LOG = "/tmp/opencode-preview-install.log"
  // How long to wait for the dev server to become reachable after spawn.
  const PREVIEW_READY_TIMEOUT_MS = 60_000
  const PREVIEW_READY_INTERVAL_MS = 500

  type Framework = "vite" | "next"

  // Returns undefined when the SDK base URL does not follow the
  // enk-opencode-hub `/user/<name>/` shape (e.g. local dev against a
  // bare opencode server). In that case the /serve/ proxy does not
  // exist and the preview tab cannot work.
  const devServerUrl = () => {
    if (!sdk.url.includes("/user/")) return undefined
    return sdk.url.replace(/\/user\//, "/serve/")
  }

  // Poll until the dev server answers with a non-5xx response, or the
  // timeout elapses. Same-origin GET — no CORS needed because /serve/
  // lives on the same host as the opencode SPA. Returns true on ready,
  // false on timeout / stale / network persistently failing.
  const waitForDevServer = async (url: string, isStale: () => boolean) => {
    const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (isStale()) return false
      try {
        const res = await fetch(url, { cache: "no-store" })
        if (res.status < 500) return true
      } catch {
        // Connection refused or network error — dev server not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_READY_INTERVAL_MS))
    }
    return false
  }

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
    // match the CHP proxy configuration in enk-opencode-hub-helm.
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

  const [previewSrc, setPreviewSrc] = createSignal<string | undefined>()
  const [previewLoading, setPreviewLoading] = createSignal(false)

  const revokePreview = () => {
    const prev = previewSrc()
    if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev)
  }

  onCleanup(revokePreview)

  const loadPreviewBlob = async (filePath: string): Promise<string | undefined> => {
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

  let previewReqId = 0
  createEffect(() => {
    // Track reactive inputs
    const diffList = diffs()
    const reviewable = hasReview()
    const myReq = ++previewReqId
    untrack(revokePreview)

    const isStale = () => myReq !== previewReqId
    const apply = (src: string | undefined) => {
      if (isStale()) return
      setPreviewLoading(false)
      setPreviewSrc(src)
    }

    if (!reviewable) {
      setPreviewLoading(false)
      setPreviewSrc(undefined)
      return
    }

    setPreviewLoading(true)

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
            // Environment does not expose a /serve/ proxy (e.g. local dev
            // against a bare opencode server). Nothing we can do.
            apply(undefined)
            return
          }
          const pty = await ensureDevServerPty(target.framework)
          if (isStale()) return
          if (!pty) {
            apply(undefined)
            return
          }
          // Wait until the dev server is actually reachable via /serve/
          // before showing the iframe; otherwise users would see a broken
          // page while bun install / bundler startup is still in progress.
          const ready = await waitForDevServer(url, isStale)
          if (isStale()) return
          apply(ready ? url : undefined)
          return
        }

        const blobUrl = await loadPreviewBlob(target.path)
        if (isStale()) {
          if (blobUrl) URL.revokeObjectURL(blobUrl)
          return
        }
        apply(blobUrl)
      } catch (error) {
        console.error("[preview] effect failed", error)
        if (!isStale()) {
          setPreviewLoading(false)
          setPreviewSrc(undefined)
        }
      }
    })()
  })
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
        }}
        style={{ width: panelWidth() }}
      >
        <div class="size-full flex border-l border-border-weaker-base">
          <div
            aria-hidden={!reviewOpen()}
            inert={!reviewOpen()}
            class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
            classList={{
              "pointer-events-none": !reviewOpen(),
            }}
          >
            <div class="size-full min-w-0 h-full bg-background-base">
              <DragDropProvider
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                collisionDetector={closestCenter}
              >
                <DragDropSensors />
                <ConstrainDragYAxis />
                <Tabs value={activeTab()} onChange={openTab}>
                  <div class="sticky top-0 shrink-0 flex">
                    <Tabs.List
                      ref={(el: HTMLDivElement) => {
                        const stop = createFileTabListSync({ el, contextOpen })
                        onCleanup(stop)
                      }}
                    >
                      <Show when={reviewTab()}>
                        <Tabs.Trigger value="review">
                          <div class="flex items-center gap-1.5">
                            <div>{language.t("session.tab.review")}</div>
                            <Show when={hasReview()}>
                              <div>{reviewCount()}</div>
                            </Show>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={hasReview()}>
                        <Tabs.Trigger value="preview">
                          <div class="flex items-center gap-1.5">
                            <div>결과 화면</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={contextOpen()}>
                        <Tabs.Trigger
                          value="context"
                          closeButton={
                            <TooltipKeybind
                              title={language.t("common.closeTab")}
                              keybind={command.keybind("tab.close")}
                              placement="bottom"
                              gutter={10}
                            >
                              <IconButton
                                icon="close-small"
                                variant="ghost"
                                class="h-5 w-5"
                                onClick={() => tabs().close("context")}
                                aria-label={language.t("common.closeTab")}
                              />
                            </TooltipKeybind>
                          }
                          hideCloseButton
                          onMiddleClick={() => tabs().close("context")}
                        >
                          <div class="flex items-center gap-2">
                            <SessionContextUsage variant="indicator" />
                            <div>{language.t("session.tab.context")}</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <SortableProvider ids={openedTabs()}>
                        <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                      </SortableProvider>
                      <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
                        <TooltipKeybind
                          title={language.t("command.file.open")}
                          keybind={command.keybind("file.open")}
                          class="flex items-center"
                        >
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            iconSize="large"
                            class="!rounded-md"
                            onClick={() => {
                              void import("@/components/dialog-select-file").then((x) => {
                                dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                              })
                            }}
                            aria-label={language.t("command.file.open")}
                          />
                        </TooltipKeybind>
                      </div>
                    </Tabs.List>
                  </div>

                  <Show when={reviewTab()}>
                    <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                    </Tabs.Content>
                  </Show>

                  <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "empty"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                          <Mark class="w-14 opacity-10" />
                          <div class="text-14-regular text-text-weak max-w-56">
                            {language.t("session.files.selectToOpen")}
                          </div>
                        </div>
                      </div>
                    </Show>
                  </Tabs.Content>

                  <Tabs.Content value="preview" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "preview"}>
                      <Switch
                        fallback={
                          <div class="flex-1 flex items-center justify-center text-center">
                            <div class="text-12-regular text-text-weak">미리볼 수 있는 결과가 없습니다</div>
                          </div>
                        }
                      >
                        <Match when={previewSrc()}>
                          {(src) => (
                            <iframe
                              src={src()}
                              class="w-full h-full border-0"
                              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                            />
                          )}
                        </Match>
                        <Match when={previewLoading()}>
                          <div class="flex-1 flex items-center justify-center text-center">
                            <div class="text-12-regular text-text-weak">결과 화면을 준비하는 중입니다…</div>
                          </div>
                        </Match>
                      </Switch>
                    </Show>
                  </Tabs.Content>

                  <Show when={contextOpen()}>
                    <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "context"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <SessionContextTab />
                        </div>
                      </Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={activeFileTab()} keyed>
                    {(tab) => <FileTabContent tab={tab} />}
                  </Show>
                </Tabs>
                <DragOverlay>
                  <Show when={store.activeDraggable} keyed>
                    {(tab) => {
                      const path = file.pathFromTab(tab)
                      return (
                        <div data-component="tabs-drag-preview">
                          <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                        </div>
                      )
                    }}
                  </Show>
                </DragOverlay>
              </DragDropProvider>
            </div>
          </div>

          <div
            id="file-tree-panel"
            aria-hidden={!fileOpen()}
            inert={!fileOpen()}
            class="relative min-w-0 h-full shrink-0 overflow-hidden"
            classList={{
              "pointer-events-none": !fileOpen(),
              "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                !props.size.active(),
            }}
            style={{ width: treeWidth() }}
          >
            <div
              class="h-full flex flex-col overflow-hidden group/filetree"
              classList={{ "border-l border-border-weaker-base": reviewOpen() }}
            >
              <Tabs
                variant="pill"
                value={fileTreeTab()}
                onChange={setFileTreeTabValue}
                class="h-full"
                data-scope="filetree"
              >
                <Tabs.List>
                  <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                    {reviewCount()}{" "}
                    {language.t(reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                    {language.t("session.files.all")}
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                  <Switch>
                    <Match when={hasReview()}>
                      <Show
                        when={diffsReady()}
                        fallback={
                          <div class="px-2 py-2 text-12-regular text-text-weak">
                            {language.t("common.loading")}
                            {language.t("common.loading.ellipsis")}
                          </div>
                        }
                      >
                        <FileTree
                          path=""
                          class="pt-3"
                          allowed={diffFiles()}
                          kinds={kinds()}
                          draggable={false}
                          active={props.activeDiff}
                          onFileClick={(node) => props.focusReviewDiff(node.path)}
                        />
                      </Show>
                    </Match>
                    <Match when={true}>
                      {empty(
                        language.t(sync.project && !sync.project.vcs ? "session.review.noChanges" : reviewEmptyKey()),
                      )}
                    </Match>
                  </Switch>
                </Tabs.Content>
                <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                  <Switch>
                    <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                    <Match when={true}>
                      <FileTree
                        path=""
                        class="pt-3"
                        modified={diffFiles()}
                        kinds={kinds()}
                        onFileClick={(node) => openTab(file.tab(node.path))}
                      />
                    </Match>
                  </Switch>
                </Tabs.Content>
              </Tabs>
            </div>
            <Show when={fileOpen()}>
              <div onPointerDown={() => props.size.start()}>
                <ResizeHandle
                  direction="horizontal"
                  edge="start"
                  size={layout.fileTree.width()}
                  min={200}
                  max={480}
                  onResize={(width) => {
                    props.size.touch()
                    layout.fileTree.resize(width)
                  }}
                />
              </div>
            </Show>
          </div>
        </div>
      </aside>
    </Show>
  )
}
