import { describe, expect, test } from "bun:test"
import { remove } from "../src/catalog"
import { formDelivery, type Client } from "../src/delivery"
import { update } from "../src/settings"

describe("release safety guards", () => {
  test("rejects model paths outside the model directory", () => {
    expect(() => remove("../../escape")).toThrow("invalid model name")
  })

  test("rejects decode settings that could stall chunking", async () => {
    await expect(update({ ceilingSec: 0 })).rejects.toThrow("invalid setting")
  })

  test("adopts an identical open draft instead of duplicating it", async () => {
    let creates = 0
    let cancels = 0
    const client = {
      session: {
        form: {
          list: async () => [{ id: "form-1", metadata: { source: "opencode-voice" } }],
          get: async () => ({ id: "form-1", fields: [{ default: "same draft" }] }),
          cancel: async () => void cancels++,
          create: async () => {
            creates++
            return { id: "form-2" }
          },
        },
        prompt: async () => {},
      },
    } satisfies Client
    const delivery = formDelivery(client, { save: async () => {}, clear: async () => {} })

    await delivery.push("session-1", "same draft")

    expect(creates).toBe(0)
    expect(cancels).toBe(0)
    expect(delivery.owns("form-1")).toBeTrue()
  })

  test("leaves an existing draft untouched when it cannot be read", async () => {
    let creates = 0
    const client = {
      session: {
        form: {
          list: async () => [{ id: "form-1", metadata: { source: "opencode-voice" } }],
          get: async () => {
            throw new Error("transport")
          },
          cancel: async () => {},
          create: async () => {
            creates++
            return { id: "form-2" }
          },
        },
        prompt: async () => {},
      },
    } satisfies Client
    const delivery = formDelivery(client, { save: async () => {}, clear: async () => {} })

    await expect(delivery.push("session-1", "new take")).rejects.toThrow("transport")
    expect(creates).toBe(0)
  })

  test("only the take's own push carries its custody token to the server", async () => {
    const saves: Array<string | undefined> = []
    const client = {
      session: {
        form: {
          list: async () => [],
          get: async () => ({ id: "none" }),
          cancel: async () => {},
          create: async () => ({ id: "form-1" }),
        },
        prompt: async () => {},
      },
    } satisfies Client
    const delivery = formDelivery(client, { save: async (_text, take) => void saves.push(take), clear: async () => {} })

    await delivery.push("session-1", "fresh take", "take-token")
    await delivery.restoreLast() // re-raise: must not acknowledge any audio
    await delivery.push("session-1", "recovered old draft") // recovery of a saved draft

    expect(saves).toEqual(["take-token", undefined, undefined])
  })
})
