import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, splitProps } from "solid-js"
import { Icon, type IconProps } from "./icon"
import "./icon-button.css"

// V1 IconButton. jitda.css 의 [data-component="icon-button"] 규칙이 이 마크업을 전제로 한다.
export interface IconButtonProps extends ComponentProps<typeof Kobalte> {
  icon: IconProps["name"]
  size?: "small" | "normal" | "large"
  iconSize?: IconProps["size"]
  variant?: "primary" | "secondary" | "ghost"
}

export function IconButton(props: ComponentProps<"button"> & IconButtonProps) {
  const [split, rest] = splitProps(props, ["variant", "size", "iconSize", "class", "classList"])
  return (
    <Kobalte
      {...rest}
      data-component="icon-button"
      data-icon={props.icon}
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      classList={{
        ...(split.classList ?? {}),
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Icon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />
    </Kobalte>
  )
}
