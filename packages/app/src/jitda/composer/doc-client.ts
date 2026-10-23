import type { DocApi } from "./doc-submit"
import { docFetch } from "./blocksuite/opencode-doc-source"

export type SessionActor = { actorID: string; sessionID: string; userID?: string; name: string; color: string }

export type DocClient = {
  actorUpsert: (input: {
    sessionID: string
    actorID?: string
    userID?: string
    name?: string
    color?: string
  }) => Promise<SessionActor>
  promptDoc: (sessionID: string) => Promise<{ docID: string; sessionID: string }>
  advance: (input: { sessionID: string; clientID: string }) => Promise<{ docID: string; sessionID: string }>
  ready: (input: {
    sessionID: string
    docID: string
    clientID: string
  }) => Promise<{ docID: string; sessionID: string }>
}

// /api/jitda/doc/session/:id/* (V1 session.actor.upsert, session.promptDoc, promptDoc2.advance/ready).
export function createDocClient(api: DocApi): DocClient {
  const call = async <T>(path: string, body?: unknown) => {
    const res = await docFetch(
      api,
      path,
      body === undefined ? { cache: "no-store" } : { method: "POST", body: JSON.stringify(body) },
    )
    if (!res.ok) throw new Error(await res.text())
    return (await res.json()) as T
  }
  const session = (id: string) => `/session/${encodeURIComponent(id)}`
  return {
    actorUpsert: ({ sessionID, ...body }) => call(`${session(sessionID)}/actor`, body),
    promptDoc: (sessionID) => call(`${session(sessionID)}/prompt-doc`),
    advance: ({ sessionID, clientID }) => call(`${session(sessionID)}/prompt-doc/advance`, { clientID }),
    ready: ({ sessionID, docID, clientID }) => call(`${session(sessionID)}/prompt-doc/ready`, { docID, clientID }),
  }
}
