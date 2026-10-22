import { Rpc } from "@opencode/plugin/rpc"

/**
 * Contract between the halves (and any external client).
 * Transcription, capture, model management, settings, update checks,
 * logging, and recovery.
 */
export const Voice = Rpc.define({
  id: "voice",
  methods: {
    transcribe: {
      input: {
        type: "object",
        properties: {
          wav: { type: "string", description: "Path to a 16kHz mono s16 WAV file" },
          client: { type: "string", description: "Initiating TUI instance; echoed in result/progress events" },
        },
        required: ["wav", "client"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: {
        busy: { type: "object", additionalProperties: false },
        model_missing: {
          type: "object",
          properties: { model: { type: "string" } },
          required: ["model"],
          additionalProperties: false,
        },
      },
    },
    recordStart: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { recorder: { type: "string" } },
        required: ["recorder"],
        additionalProperties: false,
      },
      errors: {
        busy: { type: "object", additionalProperties: false },
        no_recorder: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
        already_recording: { type: "object", additionalProperties: false },
        capture_failed: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
    recordStop: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          wav: { type: "string" },
          seconds: { type: "number" },
        },
        required: ["wav", "seconds"],
        additionalProperties: false,
      },
      errors: {
        not_recording: { type: "object", additionalProperties: false },
        capture_failed: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          recording: { type: "boolean" },
          engineLoaded: { type: "boolean" },
          modelInstalled: { type: "boolean" },
          rssMb: { type: "number" },
          cpuPct: { type: "number" },
        },
        required: ["recording", "engineLoaded", "modelInstalled", "rssMb", "cpuPct"],
        additionalProperties: false,
      },
      errors: {},
    },
    // free the model's native memory now instead of waiting for residency;
    // the next take reloads it (a few seconds)
    engineUnload: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { unloaded: { type: "boolean" } },
        required: ["unloaded"],
        additionalProperties: false,
      },
      errors: {
        busy: { type: "object", additionalProperties: false },
      },
    },
    devices: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          devices: { type: "array", items: { type: "string" } },
          recorders: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, state: { type: "string" } },
              required: ["name", "state"],
              additionalProperties: false,
            },
          },
        },
        required: ["devices", "recorders"],
        additionalProperties: false,
      },
      errors: {},
    },
    modelsList: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
      errors: {},
    },
    modelPreflight: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { json: { type: "string", description: "Preflight: needMb, freeMb|null, dir, problems[]" } },
        required: ["json"],
        additionalProperties: false,
      },
      errors: {},
    },
    modelDownload: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: {
        download_failed: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
    modelCancel: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: {},
    },
    modelDelete: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: {},
    },
    logGet: {
      input: {
        type: "object",
        properties: { file: { type: "string", description: "current or previous" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
      errors: {},
    },
    settingsGet: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
      errors: {},
    },
    settingsSet: {
      input: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
      errors: {},
    },
    settingsReset: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
      errors: {},
    },
    updateStatus: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
      errors: {},
    },
    updateRefresh: {
      input: {
        type: "object",
        properties: { force: { type: "boolean" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
      errors: {},
    },
    updateProbe: {
      input: {
        type: "object",
        properties: { channel: { type: "string" } },
        required: ["channel"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { outcome: { type: "string" } },
        required: ["outcome"],
        additionalProperties: false,
      },
      errors: {},
    },
    updateClaim: {
      input: {
        type: "object",
        properties: { version: { type: "string" } },
        required: ["version"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
        additionalProperties: false,
      },
      errors: {},
    },
    updateRenew: {
      input: {
        type: "object",
        properties: { version: { type: "string" }, token: { type: "string" } },
        required: ["version", "token"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { renewed: { type: "boolean" } },
        required: ["renewed"],
        additionalProperties: false,
      },
      errors: {},
    },
    updateAcknowledge: {
      input: {
        type: "object",
        properties: { version: { type: "string" } },
        required: ["version"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: {},
    },
    updateSettle: {
      input: {
        type: "object",
        properties: { version: { type: "string" }, token: { type: "string" }, acknowledged: { type: "boolean" } },
        required: ["version", "token", "acknowledged"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { settled: { type: "boolean" } },
        required: ["settled"],
        additionalProperties: false,
      },
      errors: {},
    },
    level: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { level: { type: "number" }, recording: { type: "boolean" } },
        required: ["level", "recording"],
        additionalProperties: false,
      },
      errors: {},
    },
    recordCancel: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: false },
      errors: {},
    },
    // safety net: the server owns the on-disk custody files (last take's
    // audio until transcription succeeds, then the draft text until sent)
    draftSave: {
      input: {
        type: "object",
        properties: {
          text: { type: "string" },
          take: { type: "string", description: "custody token from the result event; only the matching take releases its audio" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: {},
    },
    draftClear: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: false },
      errors: {},
    },
    // TUI-half forensics: failures there used to die as toasts, invisible to
    // voice.log — useless for debugging intermittent delivery/RPC errors
    clientLog: {
      input: {
        type: "object",
        properties: {
          line: { type: "string", description: "Pre-formatted; must never contain speech content" },
          debug: { type: "boolean", description: "Route through the debug gate instead of the main log" },
        },
        required: ["line"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: {},
    },
    recoverPeek: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          kind: { type: "string", description: "draft | audio | both | none" },
          text: { type: "string" },
          wav: { type: "string" },
        },
        required: ["kind", "text", "wav"],
        additionalProperties: false,
      },
      errors: {},
    },
  },
  events: {
    result: {
      schema: {
        type: "object",
        properties: {
          client: { type: "string" },
          text: { type: "string" },
          loadMs: { type: "number" },
          transcribeMs: { type: "number" },
          take: { type: "string", description: "custody token; echo to draftSave once this text is in a form" },
          error: { type: "string" },
        },
        required: ["client"],
        additionalProperties: false,
      },
    },
    download: {
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          pct: { type: "number" },
          stage: { type: "string", description: "downloading | extracting | verifying" },
          error: { type: "string" },
        },
        required: ["name", "pct"],
        additionalProperties: false,
      },
    },
    progress: {
      schema: {
        type: "object",
        properties: {
          client: { type: "string" },
          processedSec: { type: "number" },
          totalSec: { type: "number" },
        },
        required: ["client", "processedSec", "totalSec"],
        additionalProperties: false,
      },
    },
  },
})
