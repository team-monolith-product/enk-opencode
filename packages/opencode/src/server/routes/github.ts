import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { GitHub } from "../../enk/github"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"

const Member = z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(64) })
const Repo = z.object({
  owner: z.string(),
  name: z.string(),
  url: z.string(),
  private: z.boolean().optional(),
})
const Status = z
  .object({
    enabled: z.boolean(),
    connectUrl: z.string().optional(),
    login: z.string().optional(),
    linkedBy: z.string().optional(),
    repo: Repo.optional(),
    push: z.object({ sha: z.string(), time: z.number(), by: z.string().optional() }).optional(),
  })
  .meta({ ref: "GitHubStatus" })
const Pushed = z
  .object({ sha: z.string().optional(), url: z.string(), skipped: z.string().array() })
  .meta({ ref: "GitHubPush" })
const Failure = z.object({ code: z.string(), message: z.string() }).meta({ ref: "GitHubError" })
const RepoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((name) => name !== "." && name !== "..")

const failures = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((code) => [
      code,
      { description: "GitHub error", content: { "application/json": { schema: resolver(Failure) } } },
    ]),
  )

const ok = (description: string, schema: z.ZodType) => ({
  200: { description, content: { "application/json": { schema: resolver(schema) } } },
})

async function handle<T>(c: Context, fn: () => Promise<T> | T) {
  return Promise.resolve()
    .then(fn)
    .then(
      (data) => c.json(data as object),
      (err) => {
        if (!(err instanceof GitHub.Failure)) throw err
        return c.json({ code: err.code, message: err.message }, err.status)
      },
    )
}

export const GitHubRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "GitHub link status",
        description:
          "The GitHub account the team linked in Jitda and the repository bound to it. Linking itself happens in the Jitda app, so this never returns an access token.",
        operationId: "github.status",
        responses: ok("Link status", Status),
      }),
      (c) => handle(c, () => GitHub.status(Instance.directory)),
    )
    .get(
      "/repos",
      describeRoute({
        summary: "List GitHub repositories",
        description: "Repositories owned by the linked account, most recently pushed first.",
        operationId: "github.repos",
        responses: { ...ok("Repositories", Repo.array()), ...failures(409, 502) },
      }),
      (c) => handle(c, () => GitHub.repos()),
    )
    .post(
      "/repo",
      describeRoute({
        summary: "Create GitHub repository",
        description: "Create a public repository under the linked account and bind it to this project.",
        operationId: "github.repo.create",
        responses: { ...ok("Link status", Status), ...failures(409, 422, 502) },
      }),
      validator("json", z.object({ name: RepoName })),
      (c) => handle(c, () => GitHub.create(Instance.directory, c.req.valid("json"))),
    )
    .put(
      "/repo",
      describeRoute({
        summary: "Bind GitHub repository",
        description: "Bind an existing repository of the linked account to this project.",
        operationId: "github.repo.bind",
        responses: { ...ok("Link status", Status), ...failures(404, 409, 502) },
      }),
      validator("json", z.object({ owner: z.string().min(1).max(100), name: RepoName })),
      (c) => handle(c, () => GitHub.bind(Instance.directory, c.req.valid("json"))),
    )
    .post(
      "/push",
      describeRoute({
        summary: "Push to GitHub",
        description:
          "Commit a snapshot of this project on top of the bound branch and push it without force. .env files, node_modules and files over 100MB are left out.",
        operationId: "github.push",
        responses: { ...ok("Push result", Pushed), ...failures(409, 422, 502) },
      }),
      validator("json", z.object({ message: z.string().max(500).optional(), member: Member.optional() })),
      (c) => handle(c, () => GitHub.push(Instance.directory, c.req.valid("json"))),
    ),
)
