import { createContext, useContext, type Component, type JSX } from "solid-js"
import type { SessionMessageAssistantTool, SessionMessageUser } from "@opencode/client/promise"

export type MessageDocView = Component<{ id: string; fallback?: JSX.Element }>

export type HostToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  status?: string
  /** Streaming tool-input JSON, only while the call is still streaming. */
  raw?: string
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onContentRendered?: () => void
}

/**
 * Presentation choices a host embeds the timeline with. Every field is optional and the defaults keep
 * the upstream timeline; Jitda production fills them to match its V1 conversation view.
 */
export type MessageHost = {
  /** Hides agent and model labels and the per-message revert and document actions. */
  hideUserMeta?: boolean
  /** Keeps the per-message revert button even when the user meta row is hidden. */
  userRevert?: boolean
  /** Makes a user attachment's stored url loadable by the browser. */
  assetUrl?: (url: string) => string
  /** Renders the document a user message was sent from (`metadata.jitda.docID`). */
  doc?: MessageDocView
  /** Replaces the text of a user message the host recognizes, such as a handoff it sent for the team. */
  userBody?: (message: SessionMessageUser) => Component<{ id: string; text: string }> | undefined
  /** Clips the user bubble to a torn-paper edge sized to the bubble (`--paper-edge`). */
  paperEdge?: boolean
  /** Shows non-image attachments as compact file chips, and a missing image as one. */
  fileChips?: boolean
  /** Reads fields that already arrived in a streaming tool input instead of waiting for valid JSON. */
  partialInput?: boolean
  /** Replaces the renderer of the named tools. */
  tool?: (name: string) => Component<HostToolProps> | undefined
  /** Replaces the failed tool card. */
  toolError?: Component<{ tool: string; error: string; input: Record<string, unknown> }>
  /** Replaces the card that ends a failed turn. */
  sessionError?: Component<{ message: string }>
  /** Replaces the context group when it holds only tools. */
  contextGroup?: Component<{ tools: SessionMessageAssistantTool[]; busy: boolean; onSizeChange?: () => void }>
}

const context = createContext<MessageHost>({})

export const MessageHostProvider = context.Provider

export function useMessageHost() {
  return useContext(context)
}
