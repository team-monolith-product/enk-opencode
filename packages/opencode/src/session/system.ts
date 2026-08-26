import { Assets } from "../file/assets"
import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

export namespace SystemPrompt {
  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gpt")) {
      if (model.api.id.includes("codex")) {
        return [PROMPT_CODEX]
      }
      return [PROMPT_GPT]
    }
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_DEFAULT]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
        uploads(),
      ]
        .filter(Boolean)
        .join("\n"),
    ]
  }

  /** Files listed here are cheap; the same files as attachments would be re-billed every step. */
  const UPLOAD_LIST_LIMIT = 100

  /**
   * Tells the agent what the user has uploaded, so it never has to go looking, and how the folder
   * differs from the rest of the workspace. Both rules below exist because the folder is
   * git-excluded (see Assets.exclude):
   *
   *  - the originals are the only files here that nothing can restore, and
   *  - anything shipping that points at this path works in preview and breaks on deploy, which is
   *    a failure no amount of looking at the running app will reveal.
   *
   * Being excluded also hides the folder from glob/grep unless they are pointed at it, hence the
   * explicit path rather than trusting the agent to discover it.
   *
   * Returns "" when nothing has been uploaded, so a project that never uses the feature pays
   * nothing for it.
   */
  function uploads() {
    const files = Assets.list()
    if (files.length === 0) return ""

    const shown = files.slice(0, UPLOAD_LIST_LIMIT)
    return [
      `<uploads>`,
      `  The user uploaded these files directly. They were stored as-is and you have not seen their contents.`,
      `  Directory: ${Assets.root()}`,
      `  This directory is excluded from git, so glob/grep skip it unless you pass this path explicitly.`,
      `  Reading them in place is fine. Two rules apply:`,
      `  1. These are the user's originals and nothing backs them up: do not modify, delete or rename them.`,
      `  2. Nothing that ships may point here. Because the directory is not committed, code that reads a`,
      `     path under it works in preview and breaks the moment the project is committed or deployed.`,
      `     If the project needs one of these files at runtime, move it into the project's normal location`,
      `     for that kind of file (public/, assets/, fixtures/, ...) and reference it there instead.`,
      ...shown.map((file) => `  ${file.path} (${size(file.size)})`),
      ...(files.length > shown.length ? [`  [${files.length - shown.length} more]`] : []),
      `</uploads>`,
    ].join("\n")
  }

  function size(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
  }

  export async function skills(agent: Agent.Info) {
    if (Permission.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }
}
