/**
 * Delivery: how a finished transcript reaches the chat.
 *
 * REPLACEABLE BY DESIGN: everything form-specific lives
 * behind the `Delivery` interface, so a future mechanism (composer append,
 * panel editor) swaps in without touching capture/engine/panel.
 *
 * Form semantics: one tagged draft form per session,
 * tagged so foreign forms are never touched; a new take reads the open
 * form's prefill, cancels it, and raises a combined one (blank line between
 * takes); submit delivers as a queued user message, esc discards.
 *
 * OpenCode emits form.replied / form.cancelled events, which the TUI half
 * subscribes to, so delivery needs no polling.
 *
 * Known inherited limit: unsubmitted hand-edits inside an open form are
 * invisible to the API, so extending drops them (known accepted limitation).
 */

export const FORM_TAG = "opencode-voice"
import { str } from "./settings"

const formTitle = () => str("formTitle")

export interface Delivery {
  /**
   * Add a transcript to the session's draft, raising or extending its form.
   * `take` is the custody token of the audio this text came from; it is
   * forwarded to persist.save so the server can release exactly that audio.
   */
  push(sessionID: string, text: string, take?: string): Promise<{ extended: boolean }>
  /** Re-raise the most recent draft (e.g. after an accidental esc). */
  restoreLast(): Promise<boolean>
  /** A form was submitted: send the final text as a user message. */
  submitted(sessionID: string, formID: string, text: string): Promise<void>
  /** Does this form belong to us? (events arrive for all forms.) */
  owns(formID: string): boolean
  /** Forget a form (cancelled or delivered). */
  forget(formID: string): void
}

type FormInfo = { id: string; metadata?: Record<string, unknown>; fields?: unknown[] }

/** Minimal slice of the opencode client this module needs. */
export interface Client {
  session: {
    form: {
      create(input: { sessionID: string; title: string; metadata?: Record<string, unknown>; fields: unknown[] }): Promise<FormInfo>
      get(input: { sessionID: string; formID: string }): Promise<{ id: string; fields?: Array<{ default?: unknown }>; state?: { status: string } }>
      list(input: { sessionID: string }): Promise<FormInfo[]>
      cancel(input: { sessionID: string; formID: string }): Promise<unknown>
    }
    prompt(input: { sessionID: string; text: string; delivery?: "queue" | "steer" }): Promise<unknown>
  }
}

/**
 * Safety-net hooks: the draft's on-disk shadow (server-owned via RPC).
 * save() after every push, clear() once the text is actually sent — so the
 * draft survives a TUI/opencode crash until it is assured delivered.
 */
export interface Persist {
  save(text: string, take?: string): Promise<void>
  clear(): Promise<void>
  /** Forensic trail (lengths/ids/timings only — NEVER text content). */
  trace?(line: string): void
}

export function formDelivery(client: Client, persist?: Persist): Delivery {
  // formID -> sessionID, for recognizing our own form events
  const mine = new Map<string, string>()
  // most recent draft content; cleared on send, kept on cancel so an
  // accidental esc is recoverable (one level of undo, session-lifetime)
  let lastDraft: { sessionID: string; text: string } | null = null

  const trace = (line: string) => persist?.trace?.(line)
  // Log structural diagnostics only. Error messages and arbitrary data may
  // echo request content, so never serialize them into the speech-free log.
  const errs = (err: unknown): string => {
    if (!err || typeof err !== "object") return typeof err
    const e = err as Record<string, unknown>
    const fields = ["name", "type", "code", "status"]
      .filter((key) => typeof e[key] === "string" || typeof e[key] === "number")
      .map((key) => `${key}=${String(e[key])}`)
    if (typeof e.message === "string") fields.push(`messageChars=${e.message.length}`)
    if (e.data && typeof e.data === "object") fields.push(`dataKeys=${Object.keys(e.data as object).join(",")}`)
    return fields.join(" ") || "unclassified object error"
  }

  const field = (text: string) => ({
    key: "text",
    type: "string",
    title: "✎",
    default: text,
    required: true,
  })

  return {
    async push(sessionID, text, take) {
      let combined = text.trim()
      let extended = false

      // drafts live IN the form: find ours in this session and absorb it.
      // Every tolerated step failure is traced — the bare catches used to
      // destroy exactly the evidence needed for the intermittent RPC errors.
      const t0 = performance.now()
      const open = await client.session.form.list({ sessionID }).catch((err) => {
        trace(`push: form.list FAILED (draft unchanged): ${errs(err)}`)
        throw err
      })
      const ours = open.find(
        (f) => (f.metadata as { source?: string } | undefined)?.source === FORM_TAG,
      )
      if (ours) {
        const detail = await client.session.form.get({ sessionID, formID: ours.id }).catch((err) => {
          trace(`push: form.get FAILED (draft unchanged): ${errs(err)}`)
          throw err
        })
        const prior = String(detail?.fields?.[0]?.default ?? "").trim()
        if (prior && prior === combined) {
          mine.set(ours.id, sessionID)
          lastDraft = { sessionID, text: prior }
          await persist?.save(prior, take)
          trace(`push adopted existing form ${ours.id}, ${prior.length} chars`)
          return { extended: false }
        }
        if (prior) {
          combined = `${prior}\n\n${combined}`
          extended = true
        }
        await client.session.form.cancel({ sessionID, formID: ours.id }).catch((err) => {
          trace(`push: form.cancel FAILED (draft unchanged): ${errs(err)}`)
          throw err
        })
        mine.delete(ours.id)
      }

      let created: FormInfo
      try {
        created = await client.session.form.create({
          sessionID,
          title: formTitle(),
          metadata: { source: FORM_TAG },
          fields: [field(combined)],
        })
      } catch (err) {
        trace(`push: form.create FAILED: ${errs(err)} (${combined.length} chars, session ${sessionID})`)
        throw err
      }
      trace(`push ok: form ${created.id}, ${combined.length} chars${extended ? ", extended" : ""}, ${Math.round(performance.now() - t0)}ms`)
      mine.set(created.id, sessionID)
      lastDraft = { sessionID, text: combined }
      await persist?.save(combined, take)
      return { extended }
    },

    async restoreLast() {
      if (!lastDraft) return false
      const { sessionID, text } = lastDraft
      await this.push(sessionID, text)
      return true
    },

    async submitted(sessionID, formID, text) {
      mine.delete(formID)
      const final = text.trim()
      if (!final) {
        lastDraft = null
        await persist?.clear()
        return
      }
      // protect the SUBMITTED text (hand-edits included) until the send has
      // actually succeeded — submit failures (RPC errors) are the very
      // scenario the safety net exists for, so clearing first would defeat it
      lastDraft = { sessionID, text: final }
      await persist?.save(final)
      const t0 = performance.now()
      try {
        await client.session.prompt({ sessionID, text: final, delivery: str("deliveryMode") as "queue" | "steer" })
      } catch (err) {
        trace(
          `submit: session.prompt FAILED after ${Math.round(performance.now() - t0)}ms: ${errs(err)} ` +
            `(${final.length} chars, ${str("deliveryMode")}, session ${sessionID}, form ${formID})`,
        )
        throw err
      }
      trace(`submit ok: ${final.length} chars, ${Math.round(performance.now() - t0)}ms`)
      lastDraft = null // sent; nothing left to restore
      await persist?.clear()
    },

    owns(formID) {
      return mine.has(formID)
    },

    forget(formID) {
      mine.delete(formID)
    },
  }
}
