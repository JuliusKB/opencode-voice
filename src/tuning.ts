/**
 * Internal timing constants: numbers that were measured or reasoned once and
 * are not user settings. Each one says how it was chosen, so the next person
 * re-measuring it knows what to repeat. User-facing knobs live in settings.ts.
 */

/**
 * Pause detection for ceiling cuts (engine.ts). A second Silero pass over a
 * phrase that exceeds the decode ceiling reports silences this long or
 * longer; the user's VAD min silence (0.8 s default) is for line breaks and
 * is far too coarse to find a cut point. 0.25 s found a usable pause at 10
 * of 12 limits on the 2026-10-23 recordings (local/python_test/cuts.ts);
 * the speech minimum stops a single click from splitting a pause in two.
 */
export const PAUSE_MIN_SILENCE_SEC = 0.25
export const PAUSE_MIN_SPEECH_SEC = 0.1

/**
 * Silence kept on either side of a ceiling cut (split.ts). With VAD line
 * splitting off a pause can be seconds long; leading or trailing silence
 * beyond about half a second is Whisper's classic hallucination trigger and
 * decode time spent on nothing.
 */
export const MAX_CUT_SILENCE_SEC = 0.5
