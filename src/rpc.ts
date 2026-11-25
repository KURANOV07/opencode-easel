import { Rpc } from "@opencode/plugin/rpc"

const StringRecord = { type: "object", additionalProperties: true } as const

const ChartEntrySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sessionID: { type: "string" },
    title: { type: "string" },
    form: { type: "string" },
    createdAt: { type: "number" },
    payload: StringRecord,
    plain: { type: "string" },
  },
  required: ["id", "sessionID", "title", "form", "createdAt", "payload", "plain"],
  additionalProperties: false,
} as const

export const EaselRpc = Rpc.define({
  id: "easel",
  methods: {
    chartsList: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          charts: { type: "array", items: ChartEntrySchema },
          deletedKeys: { type: "array", items: { type: "string" } },
        },
        required: ["charts"],
        additionalProperties: false,
      },
    },
    chartsClear: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { cleared: { type: "number" } },
        required: ["cleared"],
        additionalProperties: false,
      },
    },
    chartDelete: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          chartID: { type: "string" },
          key: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          deleted: { type: "boolean" },
          count: { type: "number" },
          deletedKeys: { type: "array", items: { type: "string" } },
        },
        required: ["deleted", "count", "deletedKeys"],
        additionalProperties: false,
      },
    },
    chartRecord: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          payload: StringRecord,
        },
        required: ["sessionID", "payload"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          chart: ChartEntrySchema,
          count: { type: "number" },
        },
        required: ["chart", "count"],
        additionalProperties: false,
      },
    },
    configGet: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          autoCharts: { type: "boolean" },
          autoChartSkip: { type: "array", items: { type: "string" } },
        },
        required: ["autoCharts", "autoChartSkip"],
        additionalProperties: false,
      },
    },
    configSet: {
      input: {
        type: "object",
        properties: {
          autoCharts: { type: "boolean" },
          autoChartSkip: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          autoCharts: { type: "boolean" },
          autoChartSkip: { type: "array", items: { type: "string" } },
        },
        required: ["autoCharts", "autoChartSkip"],
        additionalProperties: false,
      },
    },
    autoToggle: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { autoCharts: { type: "boolean" } },
        required: ["autoCharts"],
        additionalProperties: false,
      },
    },
    status: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          autoCharts: { type: "boolean" },
          autoChartSkip: { type: "array", items: { type: "string" } },
          sessions: { type: "number" },
        },
        required: ["autoCharts", "autoChartSkip", "sessions"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          count: { type: "number" },
          chartID: { type: "string" },
          form: { type: "string" },
          title: { type: "string" },
        },
        required: ["sessionID", "count"],
        additionalProperties: false,
      },
    },
    config: {
      schema: {
        type: "object",
        properties: {
          autoCharts: { type: "boolean" },
        },
        required: ["autoCharts"],
        additionalProperties: false,
      },
    },
  },
} as const)
