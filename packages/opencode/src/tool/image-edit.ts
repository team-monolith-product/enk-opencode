import z from "zod"
import path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./image-edit.txt"
import COMMANDS_DESCRIPTION from "./image-commands.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { Writable } from "../file/writable"
import { Instance } from "../project/instance"
import { PhotoCraft } from "../enk/photocraft"
import { assertExternalDirectory } from "./external-directory"

// PhotoCraft 가 열 수 있는 형식(README). AVIF 는 쓰기만 되고 읽지 못한다.
const EDITABLE = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
  ".heic",
  ".psd",
  ".psb",
])
// 레이어를 그대로 담는 형식은 제자리 저장, 나머지는 같은 형식으로 합쳐 내보낸다(덮어쓰기).
const LAYERED = new Set([".psd", ".psb"])

export type ImageEditMetadata = {
  path: string
  steps: number
  completed: number
  failed?: { index: number; command: string; error: string }
  width?: number
  height?: number
  layers?: number
}

const Step = z.object({
  command: z.string().min(1).describe("엔진 명령 ID (예: image.adjustments.invert). image_commands 로 찾는다"),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("명령 파라미터. image_commands 의 params 설명을 따른다"),
})

export const ImageEditTool = Tool.define("image_edit", {
  description: DESCRIPTION,
  parameters: z.object({
    path: z.string().describe("편집할 이미지 경로 (프로젝트 기준 상대 경로 또는 절대 경로)"),
    steps: z.array(Step).min(1).max(PhotoCraft.MAX_STEPS).describe("차례로 실행할 명령 목록"),
  }),
  async execute(params, ctx) {
    const requested = path.isAbsolute(params.path) ? params.path : path.join(Instance.directory, params.path)
    await assertExternalDirectory(ctx, requested)
    const target = await Writable.file(requested)
    if (!target)
      throw new Error(`${params.path} 은(는) 프로젝트 안의 이미 있는 이미지 파일이 아니어서 편집할 수 없습니다.`)
    const ext = path.extname(target.real).toLowerCase()
    if (!EDITABLE.has(ext))
      throw new Error(`${ext || "확장자 없는"} 파일은 PhotoCraft 로 열 수 없습니다. 지원: ${[...EDITABLE].join(", ")}`)

    const relative = target.relative
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, target.real)],
      always: ["*"],
      metadata: { filepath: target.real },
    })

    const release = await PhotoCraft.Lock.acquire(relative, ctx.sessionID)
    if (!release) throw new Error(`${relative} 은(는) 이미 다른 AI 편집이 진행 중입니다. 끝난 뒤 다시 시도하세요.`)
    const base = { path: relative, steps: params.steps.length }
    try {
      ctx.metadata({ title: relative, metadata: { ...base, completed: 0 } as ImageEditMetadata })
      const save = LAYERED.has(ext)
        ? { path: target.real }
        : { path: target.real, ...(ext === ".jpg" || ext === ".jpeg" ? { quality: 92 } : {}) }
      const pc = PhotoCraft.open(ctx.abort)
      let completed = 0
      let info: { width?: number; height?: number; layers?: unknown[] } | undefined
      try {
        const opened = await pc.call("doc.open", { path: target.real })
        if (!opened.ok) throw new Error(`이미지를 열지 못했습니다: ${PhotoCraft.message(opened.error)}`)
        const batch = await pc.call("batch", { steps: params.steps, stopOnError: true })
        if (!batch.ok) throw new Error(`명령을 실행하지 못했습니다: ${PhotoCraft.message(batch.error)}`)
        const result = batch.result as { completed: number; results: Array<{ ok: boolean; error?: unknown }> }
        completed = result.completed
        const failedIndex = result.results.findIndex((r) => !r.ok)
        if (failedIndex >= 0) {
          // 실패한 편집은 저장하지 않는다. 원본은 그대로다.
          const failed = {
            index: failedIndex,
            command: params.steps[failedIndex]!.command,
            error: PhotoCraft.message(result.results[failedIndex]!.error),
          }
          return {
            title: relative,
            metadata: { ...base, completed, failed } as ImageEditMetadata,
            output: [
              `${failedIndex + 1}번째 명령 ${failed.command} 이(가) 실패해 아무것도 저장하지 않았습니다. 원본은 그대로입니다.`,
              `오류: ${failed.error}`,
              "image_commands 로 명령 ID 와 params 를 확인한 뒤, 처음부터 전체 명령 목록을 다시 보내세요.",
            ].join("\n"),
          }
        }
        const saved = await pc.call("doc.save", save)
        if (!saved.ok) throw new Error(`저장하지 못했습니다: ${PhotoCraft.message(saved.error)}`)
        const inspected = await pc.call("doc.inspect")
        if (inspected.ok) info = inspected.result as typeof info
      } finally {
        pc.close()
      }

      Bus.publish(File.Event.Edited, { file: target.real })
      await Bus.publish(FileWatcher.Event.Updated, { file: target.real, event: "change" })
      await FileTime.read(ctx.sessionID, target.real)

      const size = info?.width && info?.height ? `${info.width}×${info.height}` : undefined
      const layers = Array.isArray(info?.layers) ? info.layers.length : undefined
      return {
        title: relative,
        metadata: {
          ...base,
          completed,
          width: info?.width,
          height: info?.height,
          layers,
        } as ImageEditMetadata,
        output: [
          `${relative} 에 명령 ${completed}개를 적용해 저장했습니다${size ? ` (${size}${layers ? `, 레이어 ${layers}개` : ""})` : ""}.`,
          LAYERED.has(ext) ? "" : "PSD 가 아닌 형식이라 레이어는 하나로 합쳐 저장했습니다.",
          "결과 이미지는 볼 수 없으니, 크기·색 등은 수치로만 판단하고 필요하면 사용자에게 확인을 부탁하세요.",
        ]
          .filter(Boolean)
          .join("\n"),
      }
    } finally {
      await release()
    }
  },
})

export const ImageCommandsTool = Tool.define("image_commands", {
  description: COMMANDS_DESCRIPTION,
  parameters: z.object({
    filter: z.string().min(1).describe("명령 ID·이름에 들어가는 낱말 (예: curves, resize, text, blur)"),
  }),
  async execute(params, ctx) {
    const pc = PhotoCraft.open(ctx.abort)
    const reply = await pc.call("engine.commands", { filter: params.filter }).finally(() => pc.close())
    if (!reply.ok) throw new Error(`명령 목록을 가져오지 못했습니다: ${PhotoCraft.message(reply.error)}`)
    const list = (
      Array.isArray(reply.result) ? reply.result : ((reply.result as { commands?: unknown[] })?.commands ?? [])
    ) as Array<{
      id: string
      label?: string
      params?: string
    }>
    const shown = list.slice(0, 40)
    const lines = shown.map((c) => `- ${c.id}${c.label ? ` (${c.label})` : ""}${c.params ? `: ${c.params}` : ""}`)
    return {
      title: `image_commands: ${params.filter}`,
      metadata: { filter: params.filter, count: list.length },
      output: list.length
        ? [
            ...lines,
            list.length > shown.length ? `… 외 ${list.length - shown.length}개. 낱말을 더 좁혀 다시 찾으세요.` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : `"${params.filter}" 에 맞는 명령이 없습니다. 다른 낱말(영어)로 찾아보세요.`,
    }
  },
})
