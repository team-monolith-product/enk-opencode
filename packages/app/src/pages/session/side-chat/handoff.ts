import { getFilename } from "@opencode-ai/util/path"
import type { AddFilesResult, LineReferenceInput } from "@/context/prompt-doc-bridge"
import { isImagePath, type HandoffFile, type HandoffInput } from "@/utils/side-session"

/** 메인 프롬프트 doc 에 블록을 넣는 쪽(PromptDocBridge). */
export type HandoffTarget = {
  addText: (text: string) => boolean
  addReference: (path: string, nodeType?: "file") => boolean
  addLineReference: (input: LineReferenceInput) => boolean
  addFiles: (files: File[]) => Promise<AddFilesResult>
}

/** 넘길 파일의 바이트를 가져오는 쪽. 못 찾으면 undefined. */
export type HandoffSources = {
  workspace: (path: string) => Promise<Blob | undefined>
  attachment: (name: string) => Promise<{ blob: Blob; filename: string; mime: string } | undefined>
}

export type PreparedHandoff = {
  text: string
  references: HandoffFile[]
  files: File[]
  failed: string[]
}

export type HandoffResult = { failed: string[]; overflow: boolean; tooLarge: boolean }

/**
 * 넣기 전에 바이트를 전부 모은다. 네트워크를 기다리는 동안 메인 컴포저가 내려가거나(질문 독) 세션이
 * 바뀔 수 있어서, 기다림이 끝난 뒤 한 번에 넣어야 반쯤 들어간 넘기기가 생기지 않는다.
 */
export async function prepareHandoff(input: HandoffInput, sources: HandoffSources): Promise<PreparedHandoff> {
  const failed: string[] = []
  const files: File[] = []
  const references: HandoffFile[] = []
  for (const file of input.files) {
    if (!isImagePath(file.path)) {
      references.push(file)
      continue
    }
    const blob = await sources.workspace(file.path).catch(() => undefined)
    if (blob) files.push(new File([blob], getFilename(file.path), { type: blob.type }))
    else failed.push(file.path)
  }
  for (const name of input.attachments) {
    const found = await sources.attachment(name).catch(() => undefined)
    // 첨부 라우트는 텍스트 mime 을 octet-stream 으로 지운다 — 원래 파트의 mime 을 믿는다.
    if (found) files.push(new File([found.blob], found.filename, { type: found.mime || found.blob.type }))
    else failed.push(name)
  }
  return { text: input.text, references, files, failed }
}

/** 모아 둔 것을 넣는다. 넣지 못한 것은 전부 failed 로 돌려준다 — 성공 토스트가 거짓말하지 않게. */
export async function insertHandoff(prepared: PreparedHandoff, target: HandoffTarget): Promise<HandoffResult> {
  const failed = [...prepared.failed]
  if (!target.addText(prepared.text)) failed.push(excerpt(prepared.text))
  for (const file of prepared.references) {
    const ok =
      file.start !== undefined
        ? target.addLineReference({
            path: file.path,
            selection: { start: file.start, end: file.end ?? file.start },
            comment: file.comment,
          })
        : target.addReference(file.path, "file")
    if (!ok) failed.push(file.path)
  }
  if (prepared.files.length === 0) return { failed, overflow: false, tooLarge: false }
  const result = await target.addFiles(prepared.files)
  // 한도 초과는 따로 알린다. 그 밖에 하나도 안 들어갔다면 받는 쪽이 없었던 것이다.
  if (!result.added && !result.overflow && !result.tooLarge) failed.push(...prepared.files.map((file) => file.name))
  return { failed, overflow: result.overflow, tooLarge: result.tooLarge }
}

/** 토스트에 넣지 못한 본문을 가리킬 때 쓰는 짧은 인용. */
export function excerpt(text: string) {
  const line = text.trim().split("\n")[0] ?? ""
  return JSON.stringify(line.length > 24 ? `${line.slice(0, 24)}…` : line)
}

const CLAIMS = "opencode.side-chat.handoff-claims.v1"
const MAX_CLAIMS = 500

type ClaimStorage = Pick<Storage, "getItem" | "setItem">
type ClaimLocks = { request: <T>(name: string, callback: () => T | Promise<T>) => Promise<T> }

/**
 * 같은 브라우저의 여러 탭이 같은 사이드 세션을 보고 있으면 탭마다 넘기기를 넣어 공유 초안에 두 번
 * 들어간다. 탭끼리 공유되는 localStorage 에 호출 ID 를 먼저 적은 탭만 넣는다. Web Locks 로 읽기·쓰기를
 * 묶어 두 탭이 동시에 "아직 없음"을 보지 못하게 한다(없는 환경은 localStorage 만으로 최선).
 */
export async function claimHandoff(
  callID: string,
  storage: ClaimStorage | undefined = globalThis.localStorage,
  locks: ClaimLocks | undefined = (globalThis.navigator as Navigator | undefined)?.locks,
) {
  const run = () => {
    if (!storage) return true
    try {
      const raw = storage.getItem(CLAIMS)
      const list: unknown = raw ? JSON.parse(raw) : []
      const claims = Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
      if (claims.includes(callID)) return false
      storage.setItem(CLAIMS, JSON.stringify([...claims, callID].slice(-MAX_CLAIMS)))
      return true
    } catch {
      // 저장소를 못 쓰면(사생활 보호 모드 등) 이 탭이 넣는다 — 안 넣는 것보다 낫다.
      return true
    }
  }
  if (!locks) return run()
  return locks.request(CLAIMS, run)
}
