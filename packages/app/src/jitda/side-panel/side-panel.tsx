import { For, Match, Show, Switch, createEffect, createMemo, on, onCleanup, type JSX } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useDialog } from "@opencode/ui/context/dialog"
import { FileIcon } from "@opencode/ui/file-icon"
import { Mark } from "@opencode/ui/logo"
import { Tabs } from "@opencode/ui/tabs"
import { getFilename } from "@opencode/util/path"
import { IconButton } from "@/jitda/env/ui/icon-button"
import { ResizeHandle } from "@/jitda/env/ui/resize-handle"
import { TooltipKeybind } from "@/jitda/env/ui/tooltip"
import { useJitda } from "@/jitda/context"
import { Flags } from "@/jitda/flags"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useFile } from "@/workspaces/files/model"
import { useWorkspaceLocation } from "@/workspaces/location"
import { AssetUploadButton, AssetUploadProgress, createAssetUpload } from "./asset-upload-button"
import { sidePanelController, type OpenSessionFileInput } from "./controller"
import { DiffTabContent } from "./diff-tab"
import { createSessionDiffs } from "./diffs"
import { DialogSelectSessionFile, FileSearchButton } from "./file-search"
import { FileTabContent } from "./file-tabs"
import FileTree from "./file-tree"
import {
  createFileTabListSync,
  createOpenDiffTab,
  createOpenSessionFileTab,
  createSessionTabs,
  fileTab,
} from "./helpers"
import { MAX_FILE_TREE_WIDTH, MIN_FILE_TREE_WIDTH, createSessionTabStore, panelSizing, sidePanelLayout } from "./layout"
import { previewCapture } from "./preview-capture"
import { SessionBrowserChrome, SessionPreviewPanel, createSessionPreview } from "./preview-panel"

function FileVisual(props: { path: string; active?: boolean }): JSX.Element {
  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span class="truncate">{getFilename(props.path)}</span>
    </div>
  )
}

const treeDirsForReveal = (path: string) => {
  const trimmed = path.replace(/\/+$/, "")
  if (!trimmed) return [""]
  const parts = trimmed.split("/").filter(Boolean)
  const out = [""]
  let current = ""
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    out.push(current)
  }
  return out
}

const scrollTreeTo = (path: string, left = 12) => {
  requestAnimationFrame(() => {
    const panel = document.getElementById("file-tree-panel")
    const el = panel?.querySelector(`[data-file-tree-path="${CSS.escape(path)}"]`)
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" })
      return
    }
    if (left > 0) scrollTreeTo(path, left - 1)
  })
}

export function JitdaSidePanel() {
  const jitda = useJitda()
  const file = useFile()
  const location = useWorkspaceLocation()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const layout = sidePanelLayout
  const helpers = fileTab(file.normalize)

  const tabs = createSessionTabStore(() => `${jitda.directory}\n${jitda.sessionID}`)
  const sessionDiffs = createSessionDiffs(() => jitda.sessionID)

  const onContextAdd = () => sidePanelController.contextAdd()

  const assetUpload = createAssetUpload()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  // 운영 레이아웃엔 리뷰 패널을 닫는 경로가 없어(V1 review.toggle 단축키 비활성) 데스크톱이면 항상 열려 있다.
  const reviewOpen = createMemo(() => isDesktop())
  const fileOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const open = createMemo(() => reviewOpen() || fileOpen())
  const previewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (reviewOpen()) return `calc(100% - ${layout.session.width()}px)`
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffs = sessionDiffs.diffs
  const reviewCount = createMemo(() => diffs().length)
  const hasReview = createMemo(() => reviewCount() > 0)
  const diffsReady = createMemo(() => !hasReview() || sessionDiffs.loaded())

  const diffFiles = createMemo(() => diffs().map((d) => d.file))
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

  const pathFromContentTab = (tab: string) => helpers.pathFromTab(tab) ?? helpers.pathFromDiffTab(tab)

  const normalizeTab = (tab: string) => {
    if (tab.startsWith("file://")) return helpers.tab(tab)
    if (tab.startsWith("diff://")) {
      const path = helpers.pathFromDiffTab(tab)
      if (path) return helpers.diffTab(path)
    }
    return tab
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs.open,
    pathFromTab: pathFromContentTab,
    loadFile: (path) => void file.load(path),
    setActive: tabs.setActive,
  })

  const openDiffTab = createOpenDiffTab({ tabForPath: helpers.diffTab, openTab: tabs.open, setActive: tabs.setActive })

  const tabState = createSessionTabs({
    active: tabs.active,
    all: tabs.all,
    pathFromTab: pathFromContentTab,
    normalizeTab,
    preview: previewTab,
    hasReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  // 미리보기 우선: 콘텐츠가 미리보기뿐이면 탭 스트립을 숨긴다.
  const showTabStrip = createMemo(() => openedTabs().length > 0 || contextOpen())

  const preview = createSessionPreview()
  previewCapture.setBridge(preview.bridge)
  onCleanup(() => {
    if (previewCapture.bridge() === preview.bridge) previewCapture.setBridge(undefined)
    previewCapture.setCanCapture(false)
  })
  // 패널이 닫혀 미리보기 레이어 폭이 0 이면 캡처가 빈 이미지가 된다. 연결 여부는 조건에서 뺀다(재연결 깜빡임 방지).
  createEffect(() => {
    previewCapture.setCanCapture(!!preview.previewUrl() && preview.previewReady() && reviewOpen())
  })
  // 파일 탭이 활성이면 주소창에 파일 경로를 읽기 전용으로, 아니면 host 고정 + 경로 편집.
  const browserAddress = createMemo(() => {
    const active = activeFileTab()
    if (active) {
      const path = pathFromContentTab(active)
      if (path) return { host: undefined as string | undefined, path, editablePath: false }
    }
    return { host: preview.host(), path: preview.path(), editablePath: true }
  })

  const fileTreeTab = () => (Flags.disableChangeFiles ? "all" : layout.fileTree.tab())

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    if (value === "changes" && Flags.disableChangeFiles) return
    layout.fileTree.setTab(value)
  }

  createEffect(() => {
    if (Flags.disableChangeFiles && layout.fileTree.tab() === "changes") layout.fileTree.setTab("all")
  })

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const openFileSearch = () => {
    dialog.show(() => (
      <DialogSelectSessionFile
        recent={() => openedTabs().flatMap((tab) => helpers.pathFromTab(tab) ?? [])}
        onOpenFile={(path) => {
          openTab(helpers.tab(path))
          showAllFiles()
        }}
      />
    ))
  }

  const openSessionFile = (input: OpenSessionFileInput) => {
    if (input.nodeType === "directory") {
      const path = file.normalize(input.path)
      if (!layout.fileTree.opened()) layout.fileTree.open()
      layout.fileTree.setTab("all")
      for (const dir of treeDirsForReveal(path)) file.tree.expand(dir)
      scrollTreeTo(path)
      return
    }
    const applySelection = () => file.setSelectedLines(input.path, input.selection ?? null)
    if (input.origin === "review") {
      layout.fileTree.setTab("changes")
      applySelection()
      openDiffTab(input.path)
      return
    }
    layout.fileTree.setTab("all")
    const tab = helpers.tab(input.path)
    tabs.open(tab)
    tabs.setActive(tab)
    void file.load(input.path).finally(applySelection)
  }

  onCleanup(
    sidePanelController.register({
      openFile: openSessionFile,
      openFileSearch,
      showPreview: () => tabs.setActive("preview"),
    }),
  )

  command.register("jitda-side-panel", () => [
    {
      id: "file.open",
      title: language.t("command.file.open"),
      description: language.t("palette.search.placeholder"),
      keybind: "mod+k,mod+p",
      slash: "open",
      onSelect: openFileSearch,
    },
    {
      id: "tab.close",
      title: language.t("command.tab.close"),
      keybind: "mod+w",
      disabled: !activeFileTab(),
      onSelect: () => {
        const tab = activeFileTab()
        if (tab) tabs.close(tab)
      },
    },
    {
      id: "fileTree.toggle",
      title: language.t("command.fileTree.toggle"),
      keybind: "mod+\\",
      onSelect: () => layout.fileTree.toggle(),
    },
  ])

  // V1 session.tsx: 파일 트리가 열리면 루트를 읽고, 디렉토리가 바뀌면 새로 읽는다.
  let treeDir: string | undefined
  createEffect(() => {
    const dir = location().directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => location().directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = helpers.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  return (
    <Show when={isDesktop()}>
      <aside
        id="review-panel"
        data-component="codle-side-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative h-full flex shrink-0 overflow-hidden"
        classList={{
          "pointer-events-none": !open(),
          // 같은 min-width 유틸을 겹쳐 쓰면 순서에 의존하므로 상호배타로 건다. 닫힘(0px)에 걸면 다시 열려버린다.
          "min-w-0": !open(),
          "min-w-[240px]": open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !panelSizing.active(),
        }}
        style={{ width: panelWidth() }}
      >
        <div class="size-full flex flex-col border-l border-border-weaker-base">
          <SessionBrowserChrome
            previewReady={preview.previewReady()}
            previewActive={activeTab() === "preview"}
            host={browserAddress().host}
            path={browserAddress().path}
            editablePath={browserAddress().editablePath}
            onNavigatePath={preview.navigatePath}
            canGoBack={preview.canGoBack()}
            canGoForward={preview.canGoForward()}
            onBack={preview.goBack}
            onForward={preview.goForward}
            url={preview.currentUrl()}
            onReload={preview.hardReload}
            onHome={() => {
              tabs.setActive("preview")
              preview.goHome()
            }}
            showErrorButton={preview.showErrorButton()}
            errorCount={preview.errorCount()}
            errorOpen={preview.showErrorOverlay()}
            onToggleError={() => {
              // 다른 탭을 보는 중이면 미리보기 레이어가 invisible 이라 오버레이를 켜도 안 보인다.
              if (activeTab() !== "preview") return
              preview.toggleError()
            }}
            fileTreeOpen={layout.fileTree.opened()}
            onToggleFileTree={() => layout.fileTree.toggle()}
          />
          <div class="flex-1 min-h-0 flex">
            <div
              aria-hidden={!reviewOpen()}
              inert={!reviewOpen()}
              class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
              classList={{
                "pointer-events-none": !reviewOpen(),
              }}
            >
              <div class="size-full min-w-0 h-full bg-background-base">
                <Tabs value={activeTab()} onChange={openTab} class="relative">
                  {/* <Show> 로 언마운트하면 첫 파일 클릭 때 트리거가 통째로 다시 마운트되며 preview 로 폴백한다. */}
                  <div class="sticky top-0 shrink-0" classList={{ flex: showTabStrip(), hidden: !showTabStrip() }}>
                    <Tabs.List
                      ref={(el: HTMLDivElement) => {
                        const stop = createFileTabListSync({ el, contextOpen })
                        onCleanup(stop)
                      }}
                    >
                      <Show when={previewTab()}>
                        <Tabs.Trigger value="preview">
                          <div class="flex items-center gap-1.5">
                            <div>{language.t("session.tab.preview")}</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <For each={openedTabs()}>
                        {(tab) => (
                          <div class="h-full">
                            <Tabs.Trigger
                              value={tab}
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
                                    onClick={() => tabs.close(tab)}
                                    aria-label={language.t("common.closeTab")}
                                  />
                                </TooltipKeybind>
                              }
                              hideCloseButton
                              onMiddleClick={() => tabs.close(tab)}
                            >
                              <Show when={pathFromContentTab(tab)}>{(path) => <FileVisual path={path()} />}</Show>
                            </Tabs.Trigger>
                          </div>
                        )}
                      </For>
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
                            onClick={openFileSearch}
                            aria-label={language.t("command.file.open")}
                          />
                        </TooltipKeybind>
                      </div>
                    </Tabs.List>
                  </div>

                  <Show when={previewTab()}>
                    {/* iframe 은 탭과 무관하게 상시 마운트한다 — 다른 탭을 보는 중에도 penpal 연결을 유지해 컴포저의
                        "미리보기 캡처"가 동작해야 한다. Tabs.Content 는 비활성 탭을 언마운트하거나 display:none
                        (캡처 blank)으로 숨기므로 별도 레이어에서 visibility 로만 숨긴다. */}
                    <div
                      data-slot="preview-persist-layer"
                      class="overflow-hidden"
                      classList={{
                        "flex flex-col flex-1 min-h-0": activeTab() === "preview",
                        "absolute inset-0 invisible pointer-events-none": activeTab() !== "preview",
                      }}
                    >
                      <SessionPreviewPanel
                        src={preview.previewSrc()}
                        bridge={preview.bridge}
                        state={preview.previewStatus().state}
                        httpStatus={preview.previewStatus().httpStatus}
                        loopbackOnly={preview.previewStatus().loopbackOnly}
                        logs={preview.previewLogs().lines}
                        logCmd={preview.previewLogs().cmd}
                        onRetry={preview.restart}
                        retrying={preview.restarting()}
                        showError={preview.showErrorOverlay()}
                        errors={preview.errors()}
                        errorCount={preview.errorCount()}
                        onErrorReload={preview.hardReload}
                        onErrorDismiss={preview.dismissError}
                      />
                    </div>
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

                  <Show when={activeFileTab()} keyed>
                    {(tab) => (
                      <Switch>
                        <Match when={helpers.pathFromDiffTab(tab)}>
                          {(path) => (
                            <DiffTabContent
                              tab={tab}
                              path={path()}
                              active={activeFileTab() === tab}
                              diffs={diffs()}
                              loaded={sessionDiffs.loaded()}
                            />
                          )}
                        </Match>
                        <Match when={helpers.pathFromTab(tab)}>
                          {(path) => <FileTabContent tab={tab} path={path()} active={activeFileTab() === tab} />}
                        </Match>
                      </Switch>
                    )}
                  </Show>
                </Tabs>
              </div>
            </div>

            <div
              id="file-tree-panel"
              aria-hidden={!fileOpen()}
              inert={!fileOpen()}
              class="order-first relative min-w-0 h-full shrink-0 overflow-hidden"
              classList={{
                "pointer-events-none": !fileOpen(),
                "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                  !panelSizing.active(),
              }}
              style={{ width: treeWidth() }}
            >
              <div
                class="h-full flex flex-col overflow-hidden group/filetree relative"
                classList={{
                  "border-r border-border-weaker-base": reviewOpen(),
                  "outline outline-2 -outline-offset-2 outline-border-accent": assetUpload.dragging(),
                }}
                {...assetUpload.drop}
              >
                {/* 운영 레이아웃은 타이틀바가 없어 탐색기 상단에 "파일 검색" 버튼을 직접 둔다. 업로드는 프롬프트 첨부와
                    별개 경로(__assets__ 로 그대로 저장, AI 를 거치지 않음)라 보이는 버튼으로 노출한다. */}
                <div class="shrink-0 px-3 pt-3 flex flex-col gap-2">
                  <Show when={Flags.productionLayout}>
                    <FileSearchButton onClick={openFileSearch} />
                  </Show>
                  <AssetUploadButton upload={assetUpload} class="-mx-1" />
                  <AssetUploadProgress upload={assetUpload} />
                </div>
                <Tabs
                  variant="surface"
                  value={fileTreeTab()}
                  onChange={setFileTreeTabValue}
                  class="h-full"
                  data-scope="filetree"
                >
                  {/* 변경 파일 탭이 꺼져 "모든 파일" 하나뿐이면 pill 헤더를 숨기고 트리만 보인다. */}
                  <Show when={!Flags.disableChangeFiles}>
                    <Tabs.List>
                      <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                        <span data-slot="tabs-trigger-badge">{reviewCount()}</span>
                        {language.plural("session.review.change", reviewCount())}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                        {language.t("session.files.all")}
                      </Tabs.Trigger>
                    </Tabs.List>
                  </Show>
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
                            active={activeFileTab() ? helpers.pathFromDiffTab(activeFileTab()!) : undefined}
                            onFileClick={(node) => openDiffTab(node.path)}
                            onContextAdd={onContextAdd()}
                            contextLabel={language.t("session.files.addToContext")}
                            contextFolderLabel={language.t("session.files.addFolderToContext")}
                          />
                        </Show>
                      </Match>
                      <Match when={true}>{empty(language.t("session.review.noChanges"))}</Match>
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
                          onFileClick={(node) => openTab(helpers.tab(node.path))}
                          onContextAdd={onContextAdd()}
                          contextLabel={language.t("session.files.addToContext")}
                          contextFolderLabel={language.t("session.files.addFolderToContext")}
                          deletable={assetUpload.deletable}
                          onDelete={assetUpload.remove}
                          deleteLabel={language.t("session.files.delete.label")}
                        />
                      </Match>
                    </Switch>
                  </Tabs.Content>
                </Tabs>
              </div>
              <Show when={fileOpen()}>
                <div onPointerDown={() => panelSizing.start()}>
                  <ResizeHandle
                    direction="horizontal"
                    edge="end"
                    size={layout.fileTree.width()}
                    min={MIN_FILE_TREE_WIDTH}
                    max={MAX_FILE_TREE_WIDTH}
                    onResize={(width) => {
                      panelSizing.touch()
                      layout.fileTree.resize(width)
                    }}
                  />
                </div>
              </Show>
            </div>
          </div>
        </div>
      </aside>
    </Show>
  )
}
