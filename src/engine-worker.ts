/**
 * Decode worker: sherpa's decode is a SYNCHRONOUS native call that would
 * freeze the opencode server's event loop for seconds per chunk (observed:
 * dropped RPC sockets, stalled UI). Running the engine in a Worker keeps the
 * server responsive. That is its only job: the worker lives as long as the
 * server, and the model is released by the "unload" message below, never by
 * terminating the worker.
 *
 * Protocol (postMessage both ways):
 *   in : { type: "transcribe", id, wav, settings }
 *        { type: "unload" }      — drop the model in place (see below)
 *   out: { type: "progress", id, processedSec, totalSec }
 *        { type: "done", id, text, loadMs, transcribeMs, wasLoaded }
 *        { type: "error", id, message }
 *        { type: "unloaded", had }
 *        { type: "log", line }   — relayed into the server's log
 *
 * Why unload in place rather than terminate: on the Bun that opencode embeds
 * (1.4.2) Worker.terminate() leaves the sherpa-onnx native objects, their
 * thread pool and the ~0.8 GB model resident — every residency unload or
 * manual unload stacked another copy until the kernel killed the server.
 * Dropping the JS references and forcing a few collections inside the
 * worker runs the addon's finalizers and frees the memory deterministically
 * (measured: 5 load/unload cycles flat at ~0.83 GB loaded / ~0.4 GB after).
 */
import { apply, type Settings } from "./settings"

declare const self: Worker

type In = { type: "transcribe"; id: number; wav: string; settings: Settings } | { type: "unload" }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// overwrite stale stack slots that JSC's conservative scan would otherwise
// treat as live references to the dead recognizer
function churn(depth: number): number {
  const pad = new Array(64).fill(depth)
  return depth <= 0 ? pad.length : churn(depth - 1) + pad[0]
}

self.onmessage = async (event: MessageEvent<In>) => {
  const msg = event.data
  if (msg.type === "unload") {
    const engine = await import("./engine")
    const had = engine.unload()
    if (had) {
      for (let i = 0; i < 6; i++) {
        await sleep(80)
        churn(200)
        try {
          Bun.gc(true)
        } catch {
          // no synchronous gc on this runtime: finalizers run on the next collection
        }
      }
    }
    self.postMessage({ type: "unloaded", had })
    return
  }
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
