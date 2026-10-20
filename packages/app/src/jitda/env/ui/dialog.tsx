import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { type ComponentProps, type JSXElement, type ParentProps, Show } from "solid-js"
import "./dialog.css"

// V1 Dialog 마크업. V2 DialogProvider(useDialog) 안에서 열리며, jitda.css 의 hazard/env-keys/github 규칙이
// [data-component="dialog"] 구조를 전제로 해서 V2 Dialog(dialog-v2) 대신 이걸 쓴다. 짓다 다이얼로그는 모두
// action 을 넘기므로 V1 의 기본 닫기 버튼 분기는 옮기지 않았다.
export interface DialogProps extends ParentProps {
  title?: JSXElement
  description?: JSXElement
  action?: JSXElement
  size?: "normal" | "large" | "x-large"
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  fit?: boolean
  transition?: boolean
}

export function Dialog(props: DialogProps) {
  return (
    <div
      data-component="dialog"
      data-fit={props.fit ? true : undefined}
      data-size={props.size || "normal"}
      data-transition={props.transition ? true : undefined}
    >
      <div data-slot="dialog-container">
        <Kobalte.Content
          data-slot="dialog-content"
          data-no-header={!props.title && !props.action ? "" : undefined}
          classList={{
            ...(props.classList ?? {}),
            [props.class ?? ""]: !!props.class,
          }}
          onOpenAutoFocus={(e) => {
            const target = e.currentTarget as HTMLElement | null
            const autofocusEl = target?.querySelector("[autofocus]") as HTMLElement | null
            if (autofocusEl) {
              e.preventDefault()
              // V2 Dialog 와 같은 이유로 미룬다 — Kobalte 포커스 트랩이 이 이벤트 뒤에 붙는다.
              setTimeout(() => autofocusEl.focus({ preventScroll: true }))
            }
          }}
        >
          <Show when={props.title || props.action}>
            <div data-slot="dialog-header">
              <Show when={props.title}>
                <Kobalte.Title data-slot="dialog-title">{props.title}</Kobalte.Title>
              </Show>
              {props.action}
            </div>
          </Show>
          <Show when={props.description}>
            <Kobalte.Description data-slot="dialog-description" style={{ "margin-left": "-4px" }}>
              {props.description}
            </Kobalte.Description>
          </Show>
          <div data-slot="dialog-body">{props.children}</div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
