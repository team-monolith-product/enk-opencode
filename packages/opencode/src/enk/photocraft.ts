import z from "zod"
import path from "path"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"

/**
 * 헤드리스 PhotoCraft(`photocraft-cli serve`)로 이미지를 편집한다. AI 편집 도구(image_edit)가 쓴다.
 *
 * 편집 창의 웹 빌드(packages/app/public/photocraft)와 같은 엔진·같은 명령이라, 같은 명령을 실행하면 웹과
 * 바이트 단위로 같은 결과가 나온다(0.7.0 에서 웹·arm64·amd64 PSD SHA-256 일치 확인). 서버 이미지에는
 * Dockerfile 이 같은 커밋에서 빌드해 /usr/local/bin/photocraft-cli 로 넣는다. 로컬은 OPENCODE_PHOTOCRAFT_CLI.
 */
export namespace PhotoCraft {
  export const TIMEOUT_MS = 120_000
  /** serve 의 batch 한도(256)보다 작게 둬 한 번에 너무 많은 편집을 몰아넣지 않게 한다. */
  export const MAX_STEPS = 64

  export function binary() {
    const configured = process.env["OPENCODE_PHOTOCRAFT_CLI"]
    if (configured) return configured
    return Bun.which("photocraft-cli") ?? undefined
  }

  export function available() {
    return binary() !== undefined
  }

  export type Step = { command: string; params?: Record<string, unknown> }
  export type Reply = { ok: true; result: unknown } | { ok: false; error: unknown }

  /**
   * serve 세션 하나를 연다. call 로 요청을 한 줄씩 보내고 응답을 받으며, 다 쓰면 close 한다.
   * 파일 접근은 프로젝트 디렉터리로 제한한다(serve 가 그 밖의 경로를 거절한다).
   */
  export function open(signal?: AbortSignal) {
    const bin = binary()
    if (!bin) throw new Error("photocraft-cli is not installed")
    const root = Instance.directory
    const proc = Bun.spawn([bin, "serve", "--automation-read-root", root, "--automation-write-root", root], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: root,
    })
    const kill = () => proc.kill()
    const timer = setTimeout(kill, TIMEOUT_MS)
    signal?.addEventListener("abort", kill, { once: true })

    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    let id = 0
    const nextLine = async () => {
      while (true) {
        const newline = buffered.indexOf("\n")
        if (newline >= 0) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          return line
        }
        const { done, value } = await reader.read()
        if (done) return undefined
        buffered += decoder.decode(value, { stream: true })
      }
    }

    return {
      async call(method: string, params: unknown = {}): Promise<Reply> {
        proc.stdin.write(JSON.stringify({ id: id++, method, params }) + "\n")
        proc.stdin.flush()
        const line = await nextLine()
        if (line === undefined) {
          const stderr = await new Response(proc.stderr).text().catch(() => "")
          throw new Error(`photocraft-cli stopped${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`)
        }
        return JSON.parse(line) as Reply
      },
      close() {
        clearTimeout(timer)
        signal?.removeEventListener("abort", kill)
        proc.stdin.end()
        // 문서는 저장했거나 버릴 것이라 닫는 데 시간을 들일 이유가 없다.
        proc.kill()
      },
    }
  }

  /** 사람이 읽을 오류 문구. serve 는 문자열이나 {message} 로 준다. */
  export function message(error: unknown) {
    if (typeof error === "string") return error
    if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message)
    return JSON.stringify(error)
  }

  /**
   * AI 가 편집 중인 이미지. 그동안 편집 창은 보기만 되고, 사람의 저장(PUT /file/content)은 거절된다.
   * 경로는 프로젝트 디렉터리 기준 상대 경로(/ 구분)다.
   */
  export namespace Lock {
    export const Event = {
      Updated: BusEvent.define(
        "image.edit.lock",
        z.object({ path: z.string(), locked: z.boolean(), sessionID: z.string().optional() }),
      ),
    }

    const held = Instance.state(() => new Map<string, { sessionID: string; since: number }>())

    export function list() {
      return [...held().entries()].map(([file, info]) => ({ path: file, ...info }))
    }

    export function isLocked(relative: string) {
      return held().has(relative)
    }

    /** 잠그고, 해제 함수를 돌려준다. 이미 다른 편집이 잡고 있으면 undefined. */
    export async function acquire(relative: string, sessionID: string) {
      const map = held()
      if (map.has(relative)) return
      map.set(relative, { sessionID, since: Date.now() })
      await Bus.publish(Event.Updated, { path: relative, locked: true, sessionID })
      let released = false
      return async () => {
        if (released) return
        released = true
        map.delete(relative)
        await Bus.publish(Event.Updated, { path: relative, locked: false, sessionID })
      }
    }
  }

  /** 프로젝트 기준 상대 경로(/ 구분). */
  export function relative(absolute: string) {
    return path.relative(Instance.directory, absolute).split(path.sep).join("/")
  }
}
