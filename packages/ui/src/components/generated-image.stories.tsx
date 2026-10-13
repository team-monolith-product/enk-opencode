// @ts-nocheck
import { createSignal, onCleanup, onMount } from "solid-js"
import * as mod from "./generated-image"
import { DataProvider } from "../context"

const docs = `### Overview
Renderer for the \`generate_image\` tool part.

### States
- Generating: shimmer placeholder sized to the requested aspect ratio.
- Ready: the saved image (read through \`DataProvider.onReadFile\`), click to open the full-size preview.
- Blocked: moderation refused the prompt.
- No reader (share page): header only.
`

export default {
  title: "UI/GeneratedImage",
  id: "components-generated-image",
  component: mod.GeneratedImage,
  tags: ["autodocs"],
  parameters: { docs: { description: { component: docs } } },
}

const SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb4a2"/><stop offset="1" stop-color="#ffe5d9"/></linearGradient></defs>
<rect width="1024" height="1024" fill="url(#sky)"/><circle cx="760" cy="260" r="110" fill="#fff3b0"/>
<path d="M0 760 Q256 620 512 740 T1024 700 V1024 H0Z" fill="#9bc88f"/><path d="M0 860 Q300 760 620 850 T1024 820 V1024 H0Z" fill="#6aa56a"/>
<g transform="translate(380 520)"><ellipse cx="130" cy="210" rx="150" ry="110" fill="#f4a261"/><circle cx="130" cy="90" r="95" fill="#f4a261"/>
<path d="M50 30 L60 -50 L115 10Z M210 30 L200 -50 L145 10Z" fill="#f4a261"/><circle cx="95" cy="90" r="12" fill="#3d2c2e"/><circle cx="165" cy="90" r="12" fill="#3d2c2e"/>
<path d="M118 122 Q130 134 142 122" stroke="#3d2c2e" stroke-width="6" fill="none" stroke-linecap="round"/></g></svg>`

const content = { type: "text", content: btoa(SAMPLE), mimeType: "image/svg+xml", encoding: "base64" }
const data = { session: [], session_status: {}, session_diff: {}, message: {}, part: {} }
const prompt = "해 질 녘 언덕 위에 앉아 있는 귀여운 주황 고양이, 파스텔 톤 플랫 일러스트"

function Frame(props) {
  return (
    <DataProvider data={data} directory="/project" onReadFile={props.reader ?? (async () => content)}>
      <div style={{ "max-width": "720px" }}>{props.children}</div>
    </DataProvider>
  )
}

const input = (extra = {}) => ({ prompt, path: "public/ai-images/cat.png", size: "1024x1024", ...extra })

export const Generating = {
  render: () => (
    <Frame>
      <mod.GeneratedImage tool="generate_image" status="running" input={input()} metadata={{ status: "generating" }} />
    </Frame>
  ),
}

export const GeneratingLandscape = {
  render: () => (
    <Frame>
      <mod.GeneratedImage
        tool="generate_image"
        status="running"
        input={input({ size: "1536x1024", path: "public/ai-images/hero.png" })}
        metadata={{}}
      />
    </Frame>
  ),
}

export const Ready = {
  render: () => (
    <Frame>
      <mod.GeneratedImage
        tool="generate_image"
        status="completed"
        input={input()}
        metadata={{
          status: "generated",
          path: "public/ai-images/cat.png",
          mime: "image/png",
          quota: { limit: 10, used: 3, remaining: 7 },
        }}
      />
    </Frame>
  ),
}

const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<g transform="translate(250 230)"><ellipse cx="262" cy="420" rx="240" ry="170" fill="#f4a261"/><circle cx="262" cy="230" r="170" fill="#f4a261"/>
<path d="M120 120 L140 -30 L230 80Z M404 120 L384 -30 L294 80Z" fill="#f4a261"/><circle cx="200" cy="230" r="22" fill="#3d2c2e"/><circle cx="324" cy="230" r="22" fill="#3d2c2e"/>
<path d="M240 290 Q262 312 284 290" stroke="#3d2c2e" stroke-width="10" fill="none" stroke-linecap="round"/></g></svg>`

export const Transparent = {
  render: () => (
    <Frame reader={async () => ({ ...content, content: btoa(SPRITE) })}>
      <mod.GeneratedImage
        tool="generate_image"
        status="completed"
        input={input({ background: "transparent", path: "public/ai-images/cat-sprite.png", prompt: "게임용 고양이 캐릭터 스프라이트, 투명 배경" })}
        metadata={{ status: "generated", path: "public/ai-images/cat-sprite.png" }}
      />
    </Frame>
  ),
}

export const Lifecycle = {
  render: () => {
    const [status, setStatus] = createSignal("running")
    onMount(() => {
      const timer = setInterval(() => setStatus((s) => (s === "running" ? "completed" : "running")), 2500)
      onCleanup(() => clearInterval(timer))
    })
    return (
      <Frame>
        <mod.GeneratedImage
          tool="generate_image"
          status={status()}
          input={input()}
          metadata={status() === "completed" ? { status: "generated", path: "public/ai-images/cat.png" } : {}}
        />
      </Frame>
    )
  },
}

export const Blocked = {
  render: () => (
    <Frame>
      <mod.GeneratedImage
        tool="generate_image"
        status="completed"
        input={input()}
        metadata={{ status: "blocked", path: "public/ai-images/cat.png" }}
      />
    </Frame>
  ),
}

export const WithoutReader = {
  render: () => (
    <DataProvider data={data} directory="/project">
      <mod.GeneratedImage
        tool="generate_image"
        status="completed"
        input={input()}
        metadata={{ status: "generated", path: "public/ai-images/cat.png" }}
      />
    </DataProvider>
  ),
}

export const Limited = {
  render: () => (
    <Frame>
      <mod.GeneratedImage
        tool="generate_image"
        status="completed"
        input={input()}
        metadata={{ status: "limited", path: "public/ai-images/cat.png", quota: { limit: 10, used: 10, remaining: 0 } }}
      />
    </Frame>
  ),
}

export const Disabled = {
  render: () => (
    <Frame>
      <mod.GeneratedImage
        tool="generate_image"
        status="completed"
        input={input()}
        metadata={{ status: "disabled", path: "public/ai-images/cat.png", quota: { limit: 0, used: 0, remaining: 0 } }}
      />
    </Frame>
  ),
}
