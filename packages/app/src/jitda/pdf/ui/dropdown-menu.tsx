import { DropdownMenu as Kobalte } from "@kobalte/core/dropdown-menu"
import { splitProps } from "solid-js"
import type { ComponentProps, ParentProps } from "solid-js"
import "./dropdown-menu.css"

// V1 packages/ui DropdownMenu 중 PDF 툴바가 쓰는 부분만. V2 UI 키트에는 같은 마크업의 메뉴가 없다.
function DropdownMenuRoot(props: ComponentProps<typeof Kobalte>) {
  return <Kobalte {...props} data-component="dropdown-menu" />
}

function DropdownMenuTrigger(props: ParentProps<ComponentProps<typeof Kobalte.Trigger>>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Trigger
      {...rest}
      data-slot="dropdown-menu-trigger"
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </Kobalte.Trigger>
  )
}

function DropdownMenuPortal(props: ComponentProps<typeof Kobalte.Portal>) {
  return <Kobalte.Portal {...props} />
}

function DropdownMenuContent(props: ParentProps<ComponentProps<typeof Kobalte.Content>>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Content
      {...rest}
      data-component="dropdown-menu-content"
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </Kobalte.Content>
  )
}

function DropdownMenuItem(props: ParentProps<ComponentProps<typeof Kobalte.Item>>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Item
      {...rest}
      data-slot="dropdown-menu-item"
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </Kobalte.Item>
  )
}

function DropdownMenuItemLabel(props: ParentProps<ComponentProps<typeof Kobalte.ItemLabel>>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.ItemLabel
      {...rest}
      data-slot="dropdown-menu-item-label"
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </Kobalte.ItemLabel>
  )
}

export const DropdownMenu = Object.assign(DropdownMenuRoot, {
  Trigger: DropdownMenuTrigger,
  Portal: DropdownMenuPortal,
  Content: DropdownMenuContent,
  Item: DropdownMenuItem,
  ItemLabel: DropdownMenuItemLabel,
})
