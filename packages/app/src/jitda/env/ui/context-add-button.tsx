import { splitProps, type ComponentProps } from "solid-js"
import { Icon } from "./icon"
import "./context-add-button.css"

// V1 packages/ui ContextAddButton. 스타일은 V1 line-comment-styles 에 들어 있던 규칙이다.
export function ContextAddButton(props: ComponentProps<"button"> & { label: string }) {
  const [local, rest] = splitProps(props, ["label", "class", "children"])
  return (
    <button type="button" data-component="context-add-button" aria-label={local.label} class={local.class} {...rest}>
      <Icon name="plus-small" size="small" />
    </button>
  )
}
