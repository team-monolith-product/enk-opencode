import { splitProps, type ComponentProps } from "solid-js"
import "./icon.css"

// V1 아이콘 마크업·그림. V2 카탈로그엔 없거나(fit-width 등) 그림이 다르고(chevron-down), V2 Icon 은
// [data-component="icon"] 래퍼가 없어 V1 CSS 가 걸리지 않는다.
const icons = {
  file: `<path d="M11.6667 2.5H5C4.53976 2.5 4.16667 2.8731 4.16667 3.33333V16.6667C4.16667 17.1269 4.53976 17.5 5 17.5H15C15.4602 17.5 15.8333 17.1269 15.8333 16.6667V6.66667L11.6667 2.5Z" stroke="currentColor" stroke-linecap="square"/><path d="M11.6667 2.5V6.66667H15.8333" stroke="currentColor" stroke-linecap="square"/>`,
  warning: `<path d="M10 7.91667V11.6667M10 13.7417V13.75M10 2.5L1.875 16.25H18.125L10 2.5Z" stroke="currentColor" stroke-linecap="square"/>`,
  "chevron-down": `<path d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325" stroke="currentColor" stroke-linecap="square"/>`,
  "chevron-left": `<path d="M12 15L7 10L12 5" stroke="currentColor" stroke-linecap="square"/>`,
  "chevron-right": `<path d="M8 15L13 10L8 5" stroke="currentColor" stroke-linecap="square"/>`,
  "fit-width": `<path d="M2.91699 3.75V16.25M17.083 3.75V16.25M5.83366 10H14.167M5.83366 10L8.33366 7.5M5.83366 10L8.33366 12.5M14.167 10L11.667 7.5M14.167 10L11.667 12.5" stroke="currentColor" stroke-linecap="square"/>`,
  "fit-height": `<path d="M3.75 2.91699H16.25M3.75 17.083H16.25M10 5.83366V14.167M10 5.83366L7.5 8.33366M10 5.83366L12.5 8.33366M10 14.167L7.5 11.667M10 14.167L12.5 11.667" stroke="currentColor" stroke-linecap="square"/>`,
  slideshow: `<path d="M2.08301 3.33301H17.9163V13.7497H2.08301V3.33301ZM9.99967 13.7497V16.6663M6.24967 16.6663H13.7497" stroke="currentColor" stroke-linecap="square"/><path d="M8.33301 6.24967L12.4997 8.54134L8.33301 10.833V6.24967Z" fill="currentColor"/>`,
  sidebar: `<path d="M7.86667 2H5.2H2V18H5.2H7.86667M7.86667 2H18V18H7.86667M7.86667 2V18" stroke="currentColor"/>`,
  "sidebar-active": `<path d="M2 2V18H5.2H7.86667V2H5.2H2Z" fill="currentColor" fill-opacity="0.1"/>
<path d="M7.86667 2H5.2H2V18H5.2H7.86667M7.86667 2H18V18H7.86667M7.86667 2V18" stroke="currentColor"/>`,
  photo: `<path d="M16.6665 16.6666L11.6665 11.6666L9.99984 13.3333L6.6665 9.99996L3.08317 13.5833M2.9165 2.91663H17.0832V17.0833H2.9165V2.91663ZM13.3332 7.49996C13.3332 8.30537 12.6803 8.95829 11.8748 8.95829C11.0694 8.95829 10.4165 8.30537 10.4165 7.49996C10.4165 6.69454 11.0694 6.04163 11.8748 6.04163C12.6803 6.04163 13.3332 6.69454 13.3332 7.49996Z" stroke="currentColor" stroke-linecap="square"/>`,
}

export type IconName = keyof typeof icons

export interface IconProps extends ComponentProps<"svg"> {
  name: IconName
  size?: "small" | "normal" | "medium" | "large"
}

export function Icon(props: IconProps) {
  const [local, others] = splitProps(props, ["name", "size", "class", "classList"])
  return (
    <div data-component="icon" data-size={local.size || "normal"}>
      <svg
        data-slot="icon-svg"
        classList={{
          ...(local.classList || {}),
          [local.class ?? ""]: !!local.class,
        }}
        fill="none"
        viewBox="0 0 20 20"
        innerHTML={icons[local.name]}
        aria-hidden="true"
        {...others}
      />
    </div>
  )
}
