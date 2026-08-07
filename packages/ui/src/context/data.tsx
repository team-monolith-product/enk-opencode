import type { Message, Session, Part, FileDiff, SessionStatus, ProviderListResponse } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import type { JSX } from "solid-js"

type Data = {
  provider?: ProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export type AssetUrlFn = (url: string) => string

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    doc?: (props: { id: string; fallback?: JSX.Element }) => JSX.Element
    /**
     * Resolves an attachment part's url to something the browser can load. Uploads are stored as
     * `/doc/{docID}/asset/{assetID}` references relative to the opencode server, which only the
     * host knows how to reach; without a resolver the url is used as-is.
     */
    onAssetUrl?: AssetUrlFn
    /**
     * Hides errors the session recovers from on its own — file tool failures and the rate-limit
     * retry banner. The turn's final error card (every fallback model exhausted) always renders.
     * The host decides; the ui package only obeys.
     */
    hideMinorErrors?: boolean
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      get hideMinorErrors() {
        return props.hideMinorErrors ?? false
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      doc: props.doc,
      assetUrl: (url: string) => props.onAssetUrl?.(url) ?? url,
    }
  },
})
