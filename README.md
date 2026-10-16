# OpenCode Voice

**Local-first voice dictation for [OpenCode](https://opencode.ai) (v2) —
your audio and transcripts never leave your computer.** Whisper runs on your machine
([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), in-process): no cloud
APIs, no accounts, no audio or text sent anywhere.

Press **F9**, speak, press **F9** again — your words appear as an editable
draft in the chat you recorded from. Submit sends, esc discards, dictating
again extends the draft.

## Features

- **Fully offline after model download** — transcription is local compute,
  usable on air-gapped machines and confidential codebases
- **Push-to-talk** (F9 by default) with a live level meter in the sidebar panel
- **Proofread-before-send**: transcripts arrive as a prefilled form — edit,
  submit, or discard; a new take extends the open draft
- **Model manager**: curated whisper models (tiny → medium, English and
  multilingual), downloaded on demand, switchable any time
- **Voice activity detection**: pauses become line breaks, silence is never decoded
- **Noise-annotation filter**: whisper artifacts like `(buzzing)` or
  `[BLANK_AUDIO]` are dropped before they reach your chat
- **Loss-resistant safety net**: audio is kept until its draft is safely
  stored, and the draft until it is submitted; one key recovers either after
  a failure or crash
- **Settings-first design**: shortcuts, language, VAD tuning, model RAM
  residency, and meter style all live in one menu (`ctrl+alt+v`)
- **Multi-terminal safe**: transcripts land only in the terminal that recorded them

## Requirements

- **Linux** (macOS/Windows planned). Audio capture requires `pw-record`
  (PipeWire), `arecord` (ALSA), or `ffmpeg`; archive extraction requires
  `tar` with bzip2 support. These are already present on most distributions.
- OpenCode v2.0.31 or newer. The plugin runs inside OpenCode's bundled Bun runtime.
- ~110 MB–1.9 GB disk per model (downloaded on first run, your choice of size).

## Install

Add the package to your opencode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugins": ["@juliuskb/opencode-voice"]
}
```

opencode installs it automatically on next start.

<details>
<summary>From source (development)</summary>

```sh
git clone https://github.com/JuliusKB/opencode-voice
cd opencode-voice && bun install
```

Then point your config at the directory:

```json
{
  "plugins": ["/path/to/opencode-voice"]
}
```

</details>

## First run

1. Start opencode — the **Voice** panel appears in the sidebar showing
   "no model installed".
2. Press **F9** — the model manager opens. Pick one (`small.en` is the
   recommended default for English; `small` for multilingual) and confirm
   the download. Progress shows in the panel.
3. When it's ready, press **F9**, speak, **F9** again. Your transcript opens
   as a form: **submit sends it to the chat, esc discards.**

That's the entire setup.

## Usage

| Key | Action |
|---|---|
| `F9` | start / stop recording (configurable) |
| `esc` while recording | cancel the take |
| `ctrl+alt+v` | settings menu (configurable) |
| `ctrl+f9` | restore a saved draft or retry a failed take (configurable) |
| command palette → "Restore last transcript" | same recovery action |

Dictating while a draft form is open **extends** it (blank line between
takes). Note: manual edits typed into the form are lost when a new take
extends it — edit last, or submit between takes.

## Settings

`ctrl+alt+v` opens the menu. The main page covers daily use:

- **Transcription** — model (opens the model manager), language (for
  multilingual models; auto-detect by default)
- **Audio** — input device, capture tool (with per-machine availability)
- **Behavior** — model RAM residency, notification verbosity,
  queue-vs-steer delivery
- **Shortcuts** — all key bindings

**Advanced…** holds the tuned-by-default knobs: decode chunking, VAD
sensitivity, level-meter style/size/rate, toast timings, debug logging.
Changed values are marked `*` with their recommended value shown; clearing a
field reverts to it; one action resets everything.

## Data & privacy

Everything lives in `~/.local/share/opencode-voice/`:

- `models/` — downloaded whisper models (from k2-fsa's GitHub releases)
- `settings.json` — your settings
- `voice.log` (+ `.prev`) — plugin log, current and previous run. **Never
  contains speech content or transcripts** at any log level.
- `last-take.wav` / `last-draft.txt` — the **safety net** (on by default,
  Behavior → Safety net): your last take is kept on disk until it is assured
  delivered — the audio until transcription succeeds, then the draft text
  until you actually submit it. One slot, overwritten per take, deleted the
  moment delivery completes. If transcription fails or opencode crashes with
  a draft open, the restore key (`ctrl+f9`) recovers it: re-raises the saved
  draft, or re-transcribes the saved audio. Turning the setting off deletes
  both files (an active recording is removed as soon as the recorder releases it).

With the safety net enabled, audio is recorded directly to `last-take.wav` and
deleted only after its draft is safely stored. With it disabled, audio uses a
temporary WAV and is deleted after transcription.
Opening the model manager checks k2-fsa's GitHub release catalog; model files
are downloaded from GitHub only after your explicit confirmation. Audio and
transcripts are never sent with those requests.
**Deleting the directory above is a complete uninstall of all plugin data.**

## Troubleshooting

- The log page (settings menu → *Show log*) shows what the plugin is doing;
  enable *Debug logging* (Advanced → Debug) for pipeline detail.
- "no recorder found": install PipeWire (`pw-record`), ALSA utils
  (`arecord`), or `ffmpeg`. The Recorder setting shows what's detected.
- Transcription quality issues: try a larger model, or set the language
  explicitly instead of auto-detect (multilingual models only).

## License

[MIT](./LICENSE) © JuliusKB
