/**
 * Decode worker: sherpa's decode is a SYNCHRONOUS native call that would
 * freeze the opencode server's event loop for seconds per chunk (observed:
 * dropped RPC sockets, stalled UI). Running the engine in a Worker keeps the
 * server responsive; terminating the worker is also the guaranteed way to
 * release the model's native memory (residency enforcement).
 *
 * Protocol (postMessage both ways):
 *   in : { type: "transcribe", id, wav, settings }
 *   out: { type: "progress", id, processedSec, totalSec }
 *        { type: "done", id, text, loadMs, transcribeMs, wasLoaded }
 *        { type: "error", id, message }
 *        { type: "log", line }   — relayed into the server's log
 */
import { apply, type Settings } from "./settings"

declare const self: Worker

type In = { type: "transcribe"; id: number; wav: string; settings: Settings }

self.onmessage = async (event: MessageEvent<In>) => {
  const msg = event.data
  if (msg.type !== "transcribe") return
  apply(msg.settings)
  try {
    const engine = await import("./engine")
    const wasLoaded = engine.isLoaded()
    const result = await engine.transcribe(msg.wav, (processedSec, totalSec) => {
      self.postMessage({ type: "progress", id: msg.id, processedSec, totalSec })
    })
    self.postMessage({ type: "done", id: msg.id, ...result, wasLoaded })
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) })
  }
}
