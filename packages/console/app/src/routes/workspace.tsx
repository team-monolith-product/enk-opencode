import { query, createAsync, RouteSectionProps, useParams, A } from "@solidjs/router"
import { Show } from "solid-js"
import "./workspace.css"
import { IconWorkspaceLogo } from "../component/icon"
import { WorkspacePicker } from "./workspace-picker"
import { UserMenu } from "./user-menu"
import { withActor } from "~/context/auth.withActor"
import { User } from "@opencode-ai/console-core/user.js"
import { Actor } from "@opencode-ai/console-core/actor.js"
import { useLanguage } from "~/context/language"
import { useTheme } from "~/context/theme"

const getUserEmail = query(async (workspaceID: string) => {
  "use server"
  return withActor(async () => {
    const actor = Actor.assert("user")
    const email = await User.getAuthEmail(actor.properties.userID)
    return email
  }, workspaceID)
}, "userEmail")

export default function WorkspaceLayout(props: RouteSectionProps) {
  const params = useParams()
  const language = useLanguage()
  const theme = useTheme()
  const userEmail = createAsync(() => getUserEmail(params.id!))
  return (
    <main data-page="workspace">
      <header data-component="workspace-header">
        <div data-slot="header-brand">
          <A href={language.route("/")} data-component="site-title">
            <IconWorkspaceLogo />
          </A>
          <WorkspacePicker />
        </div>
        <div data-slot="header-actions">
          <button
            onClick={() => theme.toggle()}
            style="background: none; border: none; cursor: pointer; color: var(--color-text); padding: 4px; display: flex; align-items: center; justify-content: center; border-radius: 4px;"
            aria-label="Toggle theme"
          >
            <Show
              when={theme.isDark()}
              fallback={
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                </svg>
              }
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            </Show>
          </button>
          <UserMenu email={userEmail()} />
        </div>
      </header>
      <div>{props.children}</div>
    </main>
  )
}
