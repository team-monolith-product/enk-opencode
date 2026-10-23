import { createSignal, onMount, Show } from "solid-js"
import { Markdown } from "@opencode/session-ui/markdown"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { Button } from "../../env/ui/button"
import { Dialog } from "../../env/ui/dialog"
import "../queue-panel.css"

const instructions = [
  "The user is asking a quick side question about the conversation so far.",
  "Answer directly and concisely in markdown from what you already know.",
  "Do not call any tools and do not take any actions.",
].join(" ")

export const BTW = /^\/btw(?:\s+|$)/

export function btwQuestion(text: string) {
  const match = BTW.exec(text.trimStart())
  if (!match) return undefined
  return text.trimStart().slice(match[0].length).trim()
}

export function DialogBtw(props: { sessionID: string; question: string }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const [answer, setAnswer] = createSignal<string>()
  const [failed, setFailed] = createSignal(false)

  const ask = () => {
    setFailed(false)
    setAnswer(undefined)
    sdk.api.session
      .generate({ sessionID: props.sessionID, prompt: [instructions, props.question].join("\n\n") })
      .then((result) => setAnswer(result.text.trim()))
      .catch(() => setFailed(true))
  }

  onMount(ask)

  return (
    <Dialog
      title={language.t("jitda.btw.title")}
      description={language.t("jitda.btw.description")}
      transition
      fit
      class="jitda-btw-dialog"
    >
      <div data-component="jitda-btw">
        <p data-slot="jitda-btw-question">{props.question}</p>
        <Show
          when={answer()}
          fallback={
            <Show when={failed()} fallback={<p data-slot="jitda-btw-status">{language.t("jitda.btw.loading")}</p>}>
              <p data-slot="jitda-btw-status">{language.t("jitda.btw.failed")}</p>
              <Button type="button" size="normal" variant="secondary" onClick={ask}>
                {language.t("jitda.btw.retry")}
              </Button>
            </Show>
          }
        >
          {(text) => <Markdown text={text()} class="text-14-regular" />}
        </Show>
      </div>
    </Dialog>
  )
}
