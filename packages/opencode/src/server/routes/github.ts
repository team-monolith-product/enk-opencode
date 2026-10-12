import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { failures, ok } from "../enk-responses"
import z from "zod"
import { GitHub } from "../../enk/github"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"

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
const RepoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((name) => name !== "." && name !== "..")

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
      async (c) => c.json(await GitHub.status(Instance.directory)),
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
      async (c) => c.json(await GitHub.create(Instance.directory, c.req.valid("json"))),
    ),
)
