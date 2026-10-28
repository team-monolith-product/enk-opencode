// 짓다 플러그인 RPC 정의. 서버 플러그인과 웹 앱이 같이 쓰므로 런타임 의존성이 없어야 한다.

const object = { type: "object", additionalProperties: true } as const

export const Session = {
  id: "jitda.session",
  methods: {
    main: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    archive: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
    remove: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const

export const Image = {
  id: "jitda.image",
  methods: {
    get: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    toggle: {
      input: {
        type: "object",
        properties: { on: { type: "boolean" } },
        required: ["on"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { on: { type: "boolean" } },
        required: ["on"],
        additionalProperties: false,
      },
    },
  },
} as const

export const DevServer = {
  id: "jitda.dev-server",
  methods: {
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    restart: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    logs: {
      input: { type: "object", properties: { tail: { type: "number" } }, additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const

export const EnvRequest = {
  id: "jitda.env-request",
  methods: {
    list: { input: { type: "object", additionalProperties: false }, output: object },
    submit: {
      input: {
        type: "object",
        properties: { requestID: { type: "string" }, value: { type: "string" }, name: { type: "string" } },
        required: ["requestID", "value"],
        additionalProperties: false,
      },
      output: object,
    },
    skip: {
      input: {
        type: "object",
        properties: { requestID: { type: "string" } },
        required: ["requestID"],
        additionalProperties: false,
      },
      output: object,
    },
    reject: {
      input: {
        type: "object",
        properties: { requestID: { type: "string" } },
        required: ["requestID"],
        additionalProperties: false,
      },
      output: object,
    },
  },
  events: {
    asked: { schema: object },
    resolved: { schema: object },
  },
} as const

export const EnvFile = {
  id: "jitda.env-file",
  methods: {
    list: { input: { type: "object", additionalProperties: false }, output: object },
    value: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: object,
    },
    set: {
      input: {
        type: "object",
        properties: { values: { type: "object", additionalProperties: { type: "string" } } },
        required: ["values"],
        additionalProperties: false,
      },
      output: object,
    },
    remove: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: object,
    },
  },
  events: {},
} as const

export const Env = {
  id: "jitda.env",
  methods: { get: { input: { type: "object", additionalProperties: false }, output: object } },
  events: {},
} as const

export const Github = {
  id: "jitda.github",
  methods: {
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    createRepo: {
      input: {
        type: "object",
        properties: { name: { type: "string" }, locale: { type: "string", enum: ["ko", "en", "ar"] } },
        required: ["name"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const

export const ProjectSummary = {
  id: "jitda.project-summary",
  methods: {
    generate: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const

export const InitialPlan = {
  id: "jitda.initial-plan",
  methods: {
    deliver: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const
