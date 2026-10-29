import type { Component } from "solid-js"
import { GeneratedImage, type GeneratedImageProps } from "./generated-image"

// session-ui 의 registerTool 을 받아 짓다 도구 카드를 등록한다(session-ui 패키지가 레지스트리를 export 하지 않아 주입받는다).
export function registerJitdaTools(
  register: (input: { name: string; render: Component<GeneratedImageProps> }) => unknown,
) {
  register({ name: "generate_image", render: GeneratedImage })
}
