import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { TextField } from "@opencode-ai/ui/text-field"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type Shape = "square" | "landscape" | "portrait"

export function DialogGenerateImage(props: { onSubmit: (text: string) => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const language = useLanguage()

  const [description, setDescription] = createSignal("")
  const [shape, setShape] = createSignal<Shape>("square")
  const [transparent, setTransparent] = createSignal(false)

  const [status] = createResource(() =>
    sdk.client.imageRequest
      .quota({ directory: sdk.directory })
      .then((x) => x.data)
      .catch(() => undefined),
  )
  const quota = createMemo(() => status()?.quota)
  const exhausted = createMemo(() => {
    const value = quota()
    return !!value && value.remaining <= 0
  })

  const shapeLabel = (value: Shape) => language.t(`imageRequest.shape.${value}`)

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const text = description().trim()
    if (!text || exhausted()) return
    const lines = [
      language.t("imageDialog.message", { description: text }),
      language.t("imageDialog.messageShape", { shape: shapeLabel(shape()) }),
      ...(transparent() ? [language.t("imageDialog.messageTransparent")] : []),
    ]
    props.onSubmit(lines.join("\n"))
    dialog.close()
  }

  return (
    <Dialog
      title={language.t("imageDialog.title")}
      description={language.t("imageDialog.description")}
      class="w-full max-w-[480px] mx-auto"
    >
      <form onSubmit={submit} class="flex flex-col gap-4 px-6 pb-6">
        <TextField
          multiline
          autofocus
          label={language.t("imageRequest.field.prompt")}
          placeholder={language.t("imageDialog.placeholder")}
          value={description()}
          onChange={setDescription}
          disabled={exhausted()}
        />
        <div class="flex flex-col gap-2">
          <span class="text-12-medium text-text-weak">{language.t("imageDialog.shape")}</span>
          <RadioGroup
            options={["square", "landscape", "portrait"] as Shape[]}
            current={shape()}
            label={shapeLabel}
            onSelect={(value) => value && setShape(value)}
            size="small"
          />
        </div>
        <Checkbox checked={transparent()} onChange={setTransparent}>
          {language.t("imageDialog.transparent")}
        </Checkbox>
        <div class="flex items-center gap-2">
          <span class="text-12-regular text-text-weak min-w-0 truncate">
            <Show
              when={exhausted()}
              fallback={
                <Show when={quota()}>
                  {(value) =>
                    language.t("imageRequest.remaining", { remaining: value().remaining, limit: value().limit })
                  }
                </Show>
              }
            >
              {language.t("imageDialog.empty", { limit: quota()?.limit ?? 0 })}
            </Show>
          </span>
          <div class="flex-1" />
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("imageDialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={!description().trim() || exhausted()}>
            {language.t("imageDialog.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
