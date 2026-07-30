import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { generateObject } from "ai"
import z from "zod"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Session } from "../../session"
import { SessionSummary } from "../../session/summary"
import { SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Provider } from "../../provider/provider"
import { Database, inArray } from "../../storage/db"
import { MessageTable } from "../../session/session.sql"
import { PlanDoc } from "../../enk/plan-doc"
import { lazy } from "../../util/lazy"
import { collectFiles, buildWorkspaceContext } from "./project-summary"

const PlanDocBusy = z.object({ error: z.literal("busy") }).meta({ ref: "PlanDocBusy" })

const EMPTY_CAVEAT = "작업 기록이 부족해서 기획서 틀만 준비했어요. 빈칸을 직접 채워주세요."
const DEGRADED_CAVEAT = "툴 사용 기록이 없는 세션이라 대화 내용만으로 작성했어요. 내용을 꼭 확인해 주세요."

async function resolveSession(sessionID?: SessionID) {
  if (sessionID) {
    const found = await Session.get(sessionID).catch(() => undefined)
    if (found) return found
  }
  const candidates = [...Session.listGlobal({ roots: true, limit: 50 })]
  if (candidates.length === 0) return undefined
  const rows = Database.use((db) =>
    db
      .select({ session_id: MessageTable.session_id, data: MessageTable.data })
      .from(MessageTable)
      .where(
        inArray(
          MessageTable.session_id,
          candidates.map((s) => s.id),
        ),
      )
      .all(),
  )
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.data.role === "user") counts.set(row.session_id, (counts.get(row.session_id) ?? 0) + 1)
  }
  const picked = PlanDoc.selectPrimary(
    candidates.map((s) => ({ id: s.id, userCount: counts.get(s.id) ?? 0, updated: s.time.updated })),
  )
  return candidates.find((s) => s.id === picked)
}

async function readPlanFile(session: Session.Info) {
  try {
    const file = Session.plan({ slug: session.slug, time: { created: session.time.created } })
    return await readFile(file, "utf8")
  } catch {
    return ""
  }
}

async function readDependencies(root: string) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
    return [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]
  } catch {
    return []
  }
}

const SYSTEM = [
  "당신은 해커톤 참가 팀의 기획서를 작성합니다. 독자는 참가자 본인과 교사입니다.",
  "정직성 규칙:",
  "- 근거 없는 수치(%, 배수, 사용자 수), 최상급 표현(최고·혁신·완벽·최초), AI 동작 원리 단정(AI가 분석/추천/설계/학습)을 쓰지 않습니다.",
  "- 라이브러리·프레임워크·파일·함수·API·모델 이름을 쓰지 않습니다.",
  "- 완성되지 않은 기능은 features의 status를 planned 또는 unfinished로 구분하고, 절대 완성으로 기재하지 않습니다.",
  "- 작업 기록 속 AI의 자기 보고(고쳤습니다, 완료했습니다)는 사실 근거가 아닙니다. 세션 순변경과 워크스페이스가 근거입니다.",
  "- changelog에서 keptInFinal이 false인 항목(되돌린 시도)은 완성된 것으로 쓰지 않습니다.",
  "- 실명이 등장하면 이니셜로 마스킹합니다(예: 김철수 → K).",
  "- 채울 근거가 부족한 블록은 지어내지 말고 manualSlots에 블록 키를 넣고 해당 필드는 비워두세요.",
  `- manualSlots에 쓸 수 있는 키: ${PlanDoc.BLOCKS.join(", ")}`,
  "- 작업 기록(transcript)의 언어와 같은 언어로 작성하세요.",
].join("\n")

function buildPrompt(input: {
  transcript: string
  netDiff: string
  planFile: string
  workspace: string
  degraded: boolean
}) {
  return `다음 자료를 바탕으로 해커톤 팀의 기획서 초안을 작성하세요.
세션 순변경과 워크스페이스가 실제 만들어진 결과물의 권위 있는 근거이며, 작업 기록은 보조 단서입니다. 충돌하면 워크스페이스를 우선하세요.
${input.degraded ? "이 세션에는 툴 사용 기록이 없어 대화 텍스트만 근거로 삼을 수 있습니다. 확신이 없는 블록은 manualSlots로 비워두세요.\n" : ""}
필드 안내:
- title: 결과물의 이름 또는 한 줄 정체성.
- tagline: 결과물을 소개하는 한 줄.
- problem: 팀이 풀려던 문제. 만든 사람의 시점으로.
- targetUsers: 누구를 위한 것인지.
- userStories: 사용자가 무엇을 할 수 있는지. "~는 ~할 수 있다" 형태.
- features: 주요 기능과 상태. 실제로 동작이 확인된 것만 works.
- screens: 화면 구성. 화면 단위로 한 줄씩.
- tech.overview: 어떤 구조로 동작하는지 비개발자도 읽을 수 있게. tech.data: 어떤 정보를 다루고 어떻게 저장·이동하는지.
- changelog: 작업 흐름의 마일스톤. kind는 add(추가)/fix(수정)/rollback(시도 후 되돌림)/pivot(방향 전환). 되돌린 시도는 rollback + keptInFinal=false.
- narrative: 포트폴리오용 서사형 산문(마크다운, 3~6문단). 문제 인식 → 시도와 우여곡절(되돌린 시도 포함) → 최종 결과 → 배운 점 순서.
- caveats: 독자가 알아야 할 주의사항.

작업 기록:
${input.transcript || "(없음)"}

${input.netDiff || "(세션 순변경 없음)"}

${input.planFile ? `계획 문서:\n${input.planFile}` : ""}

${input.workspace || "(워크스페이스 비어있음)"}`
}

export const PlanDocRoutes = lazy(() =>
  new Hono().post(
    "/generate",
    describeRoute({
      summary: "Generate plan document",
      description:
        "Generate a hackathon plan document (standard + narrative markdown) from the session transcript, tool events, net diff and workspace state. Always returns 200 with manual slots when input is sparse.",
      operationId: "planDoc.generate",
      responses: {
        200: {
          description: "Generated plan document",
          content: {
            "application/json": {
              schema: resolver(PlanDoc.Result),
            },
          },
        },
        409: {
          description: "Selected session has an assistant turn in flight",
          content: {
            "application/json": {
              schema: resolver(PlanDocBusy),
            },
          },
        },
      },
    }),
    validator(
      "json",
      z.object({
        sessionID: SessionID.zod.optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const session = await resolveSession(body.sessionID)
      if (!session) return c.json(PlanDoc.skeleton(EMPTY_CAVEAT))

      const msgs = await Session.messages({ sessionID: session.id })
      if (PlanDoc.isBusy(msgs)) return c.json({ error: "busy" as const }, 409)

      const serialized = PlanDoc.serialize(msgs, session.directory)
      const netDiffs = await SessionSummary.computeDiff({ messages: msgs }).catch(() => [])
      const netDiff = PlanDoc.renderNetDiff(netDiffs, session.directory)
      const planFile = await readPlanFile(session)
      const files = await collectFiles(session.directory)
      const workspace = await buildWorkspaceContext(session.directory, serialized.transcript, files)

      if (!serialized.transcript && !netDiff && !planFile && !workspace) {
        return c.json(PlanDoc.skeleton(EMPTY_CAVEAT))
      }

      let providerID: ProviderID | undefined
      let modelID: ModelID | undefined
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i].info
        if (info.role === "user") {
          providerID = info.model.providerID
          modelID = info.model.modelID
          break
        }
      }
      if (!providerID || !modelID) {
        const def = await Provider.defaultModel()
        providerID = def.providerID
        modelID = def.modelID
      }
      const info = await Provider.getModel(providerID, modelID)
      const language = await Provider.getLanguage(info)

      const deps = await readDependencies(session.directory)
      const terms = PlanDoc.bannedTerms({ files, dependencies: deps })
      const prompt = buildPrompt({
        transcript: serialized.transcript,
        netDiff,
        planFile,
        workspace,
        degraded: serialized.degraded,
      })

      const generate = (feedback?: string) =>
        generateObject({
          model: language,
          abortSignal: c.req.raw.signal,
          schema: PlanDoc.Shape,
          system: SYSTEM,
          prompt: feedback ? `${prompt}\n\n${feedback}` : prompt,
        }).then((result) => PlanDoc.clamp(result.object))

      let object = await generate()
      const extraCaveats: string[] = []
      const violations = PlanDoc.findViolations(object, terms)
      if (violations.length > 0) {
        const feedback = [
          "이전 초안에서 다음 문장들이 정직성 규칙을 위반했습니다. 해당 표현 없이 다시 작성하세요:",
          ...violations.map((v) => `- [${v.reason}] ${v.text}`),
        ].join("\n")
        object = await generate(feedback).catch((err) => {
          if (c.req.raw.signal.aborted) throw err
          return object
        })
        if (PlanDoc.findViolations(object, terms).length > 0) {
          const stripped = PlanDoc.stripViolations(object, terms)
          object = stripped.shape
          extraCaveats.push(...stripped.caveats)
        }
      }
      if (serialized.degraded) extraCaveats.push(DEGRADED_CAVEAT)

      return c.json(PlanDoc.finalize(object, extraCaveats))
    },
  ),
)
