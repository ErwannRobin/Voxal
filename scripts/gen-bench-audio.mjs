// Generate the deterministic speech-like WAV the benchmark feeds to Chromium's
// fake microphone (`--use-file-for-fake-audio-capture`).
//
// Why not just use Chromium's built-in fake device: it emits a 440 Hz sine.
// Opus encodes a pure tone at a small fraction of the 32 kb/s ceiling
// `OPUS_MAX_BITRATE` sets, so every bandwidth number measured against it would
// be far below what a real call costs — the benchmark would flatter itself.
//
// So we synthesise a signal with speech's *statistics* rather than its meaning:
// noise shaped by three formant-ish resonators, driven by a syllabic amplitude
// envelope with real pauses in it. That lands Opus in its normal operating
// range and, because the PRNG is seeded, the file is byte-identical on every
// machine — two runs are comparable, which is the whole point.
//
// 16-bit mono PCM: Chromium's fake-capture reader accepts nothing else, and
// the app forces `stereo=0` downstream anyway (OPUS_FMTP_PARAMS).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SAMPLE_RATE = 48000; // Opus's native rate; avoids a resample on capture
const SECONDS = 10;        // Chromium loops the file, so this only sets the period
const SEED = 0x5f3a7c21;

/** xorshift32 — seeded, so the generated file is identical on every machine. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000 * 2 - 1; // [-1, 1)
  };
}

/**
 * One-pole-per-side resonant bandpass, applied in series to white noise. Three
 * of these at formant frequencies is what makes the result read as voiced
 * rather than as hiss — and hiss is exactly what a noise suppressor would gate
 * away, which would put us back to measuring silence.
 */
function makeResonator(freq, q) {
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  const r = Math.exp(-w / (2 * q));
  const a = (1 - r * r) * Math.sin(w);
  let y1 = 0, y2 = 0;
  return (x) => {
    const y = a * x + 2 * r * Math.cos(w) * y1 - r * r * y2;
    y2 = y1; y1 = y;
    return y;
  };
}

function synthesise() {
  const rand = makeRandom(SEED);
  const n = SAMPLE_RATE * SECONDS;
  const out = new Float32Array(n);
  // Roughly the first three formants of a neutral vowel.
  const formants = [makeResonator(500, 12), makeResonator(1500, 10), makeResonator(2500, 8)];

  // Syllables at ~4 Hz (normal speech rate), grouped into phrases with silence
  // between them — the pauses matter, because a signal that never stops would
  // hide how the encoder behaves at onsets, which is where PTT lives.
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const phrase = t % 3.2 < 2.4 ? 1 : 0;                       // 2.4s on, 0.8s off
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);  // 4 Hz envelope
    const envelope = phrase * (0.25 + 0.75 * syllable * syllable);

    let x = rand();
    let sum = 0;
    for (const f of formants) sum += f(x);
    out[i] = Math.max(-1, Math.min(1, sum * 0.6)) * envelope;
  }

  // Normalise to -3 dBFS peak so the level is defined rather than incidental.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const gain = peak > 0 ? 0.708 / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

function toWav(samples) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);            // PCM chunk size
  buf.writeUInt16LE(1, 20);             // format: PCM
  buf.writeUInt16LE(1, 22);             // channels: mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);             // block align
  buf.writeUInt16LE(16, 34);            // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  return buf;
}

const target = process.argv[2] || 'tests/bench/assets/bench-speech.wav';
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, toWav(synthesise()));
console.log(`→ ${target} (${SECONDS}s, ${SAMPLE_RATE} Hz, 16-bit mono)`);
