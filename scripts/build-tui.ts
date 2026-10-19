/**
 * Compile the TUI half for publishing.
 *
 * Why this exists: OpenCode compiles a plugin's .tsx differently depending on
 * where the file lives. Outside node_modules (a local checkout) it runs
 * Solid's JSX compiler, which emits fine-grained reactive code. Inside
 * node_modules (every npm install) it falls back to Bun's generic JSX
 * transform, which evaluates every prop once: the panel renders its initial
 * state and never updates. Shipping the panel precompiled with OpenTUI's own
 * Solid plugin (the same compiler the host embeds) makes both paths identical.
 *
 * Output: dist/tui.js, importing only solid-js, @opentui/solid and the plugin
 * SDK by bare name; the host maps those to its own instances at load time.
 * package.json is inlined into the bundle (version and release notes), so the
 * panel's version is the one it was built with.
 */
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

export async function buildTui(outdir = "dist"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [new URL("../src/tui.tsx", import.meta.url).pathname],
    outdir,
    target: "bun",
    format: "esm",
    external: ["solid-js", "solid-js/*", "@opentui/*", "@opencode/*", "sherpa-onnx-node"],
    plugins: [createSolidTransformPlugin({ moduleName: "@opentui/solid" })],
  })
  if (!result.success) throw new Error(result.logs.map(String).join("\n") || "build failed")
  const out = `${outdir}/tui.js`
  verifyCompiled(await Bun.file(out).text())
  return out
}

/** Fail the build if the output is not Solid-compiled reactive code. */
export function verifyCompiled(code: string): void {
  if (/\bjsxDEV?\(|\bjsxs\(/.test(code))
    throw new Error("dist/tui.js contains generic JSX runtime calls; the Solid transform did not run")
  if (!/from "@opentui\/solid"/.test(code)) throw new Error("dist/tui.js does not import the OpenTUI Solid runtime")
  if (!/\bget when\(\)/.test(code) || !/\binsert\(/.test(code))
    throw new Error("dist/tui.js lacks reactive getters/inserts; the panel would render once and freeze")
}

if (import.meta.main) {
  const out = await buildTui()
  console.log(`built ${out} (${(await Bun.file(out).size) / 1024 | 0} KB)`)
}
