import { createMemo, Show } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { Button } from "@/jitda/env/ui/button"
import { Keybind } from "@/jitda/env/ui/keybind"
import { CommandPaletteView } from "@/shell/commands/dialog"
import { createCommandPaletteFileEntry } from "@/shell/commands/palette"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useFile } from "@/workspaces/files/model"

const ENTRY_LIMIT = 5

// 겉모습은 input 이지만 누르면 파일 검색 모달을 여는 버튼(V1 components/session/file-search-button).
export function FileSearchButton(props: {
  projectName?: string
  showKeybind?: boolean
  onClick?: () => void
  class?: string
}) {
  const command = useCommand()
  const language = useLanguage()
  const hotkey = createMemo(() => command.keybind("file.open"))
  const showKeybind = () => props.showKeybind !== false

  return (
    <Button
      type="button"
      variant="ghost"
      size="small"
      class={`items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-panel shadow-none cursor-default ${props.class ?? "flex w-full max-w-full min-w-0"}`}
      onClick={() => (props.onClick ? props.onClick() : command.trigger("file.open"))}
      aria-label={language.t("session.header.searchFiles")}
    >
      <div class="flex min-w-0 flex-1 items-center overflow-visible">
        <span class="flex-1 min-w-0 text-12-regular text-text-weak truncate text-left">
          {props.projectName
            ? language.t("session.header.search.placeholder", { project: props.projectName })
            : language.t("session.header.searchFiles")}
        </span>
      </div>

      <Show when={showKeybind() && hotkey()}>
        {(keybind) => (
          <Keybind class="shrink-0 !border-0 !bg-transparent !shadow-none px-0 text-text-weaker">{keybind()}</Keybind>
        )}
      </Show>
    </Button>
  )
}

// V1 DialogSelectFile mode="files" 자리. V2 명령 팔레트 화면을 파일 전용으로 쓰고, 고른 파일은 이 패널의 탭으로 연다.
export function DialogSelectSessionFile(props: { recent: () => string[]; onOpenFile: (path: string) => void }) {
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const category = () => language.t("palette.group.files")

  const items = (query: string) => {
    if (query) return []
    const recent = props.recent().slice(0, ENTRY_LIMIT)
    const root = file.tree
      .children("")
      .filter((node) => node.type === "file" && !recent.includes(node.path))
      .map((node) => node.path)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, ENTRY_LIMIT)
    return [...recent, ...root].map((path) => createCommandPaletteFileEntry(path, category()))
  }

  return (
    <CommandPaletteView
      placeholder={language.t("palette.search.placeholder")}
      items={items}
      sources={[
        async (query, signal) => {
          if (!query) return []
          const files = await file.searchFiles(query, { signal })
          return files.map((path) => createCommandPaletteFileEntry(path, category()))
        },
      ]}
      highlight={() => {}}
      select={(item) => {
        if (!item?.path) return
        dialog.close()
        props.onOpenFile(item.path)
      }}
      close={() => dialog.close()}
    />
  )
}
