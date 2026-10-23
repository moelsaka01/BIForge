"""Original music and sound effects for the BIForge LinkedIn ad, synthesized from scratch with numpy.

    python marketing/linkedin-ad/audio/make_music.py [out.wav]

Nothing here uses samples, loops or recordings: every sound is generated from sine/saw oscillators, noise and
simple envelopes in this file. The structure follows site/timeline.json (the same file drives the animation):

    0:00-0:03  soft synth swell (Am9 pad rising in brightness and level)
    0:03       the beat enters (kick, hats), 120 BPM, A minor (Am - F - C - G)
    0:05+      clap, bass; 0:07+ pluck arpeggio; builds every 2 bars
    0:15-0:17  riser and snare roll into the sharing montage
    0:17-0:23  peak energy: 16th hats, lead, full bass, kick on every beat
    0:23       one clean chime, then silence on the end card
Key clicks follow the typed captions in the timeline; swooshes and soft clicks are placed on the scene cuts.
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
HERE = Path(__file__).resolve().parent
TL = json.loads((HERE.parent / "site" / "timeline.json").read_text(encoding="utf8"))
DUR = TL["duration"]
N = int(SR * DUR)
BPM = 120.0
BEAT = 60.0 / BPM
rng = np.random.default_rng(20261023)  # fixed seed: the track is reproducible


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12.0)


def t_of(length):
    return np.arange(int(SR * length)) / SR


class Bus:
    def __init__(self):
        self.l = np.zeros(N + SR * 6)
        self.r = np.zeros(N + SR * 6)

    def add(self, start, sig, gain=1.0, pan=0.0):
        i = int(start * SR)
        if i < 0 or i >= len(self.l):
            return
        end = min(len(self.l), i + len(sig))
        s = sig[: end - i] * gain
        lg = np.cos((pan + 1) * np.pi / 4)
        rg = np.sin((pan + 1) * np.pi / 4)
        self.l[i:end] += s * lg
        self.r[i:end] += s * rg


def lowpass(x, cutoff):
    """one-pole low-pass (cutoff in Hz, scalar or per-sample array)"""
    c = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * c / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def reverb_ir(seconds, seed):
    g = np.random.default_rng(seed)
    t = t_of(seconds)
    ir = g.standard_normal(len(t)) * np.exp(-t * 3.2 / seconds * 2.0)
    ir = lowpass(ir, 5200)
    ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
    return ir / np.sqrt(np.sum(ir ** 2))


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    nfft = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, nfft) * np.fft.rfft(ir, nfft), nfft)[:n]
    return y[: len(x)]


# ---------------------------------------------------------------- instruments
def kick(vel=1.0):
    t = t_of(0.42)
    f = 46 + 120 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 9)
    click = np.sin(2 * np.pi * 1800 * t) * np.exp(-t * 240) * 0.35
    return np.tanh((body + click) * 1.6) * vel


def clap(vel=1.0):
    t = t_of(0.28)
    n = highpass(rng.standard_normal(len(t)), 900)
    n = lowpass(n, 7500)
    env = np.zeros_like(t)
    for k, d in enumerate([0, 0.011, 0.024]):
        env += np.where(t >= d, np.exp(-(t - d) * 90), 0) * (0.7 if k < 2 else 1.0)
    env *= np.exp(-t * 14)
    return n * env * vel * 0.9


def hat(vel=1.0, open_=False):
    length = 0.18 if open_ else 0.05
    t = t_of(length)
    n = highpass(rng.standard_normal(len(t)), 6500)
    return n * np.exp(-t * (22 if open_ else 95)) * vel * 0.5


def snare_hit(vel=1.0):
    t = t_of(0.2)
    n = highpass(rng.standard_normal(len(t)), 1200) * np.exp(-t * 28)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 40) * 0.6
    return (n * 0.8 + tone) * vel


def bass_note(freq, length, vel=1.0):
    t = t_of(length)
    ph = 2 * np.pi * freq * t
    sig = np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.18 * np.sin(3 * ph)
    env = np.minimum(1, t / 0.006) * np.exp(-t * 3.0) * np.minimum(1, (length - t) / 0.03)
    return sig * env * vel * 0.8


def pluck(freq, length=0.5, vel=1.0):
    """FM-ish pluck: bright attack that mellows quickly"""
    t = t_of(length)
    idx = 2.2 * np.exp(-t * 14)
    sig = np.sin(2 * np.pi * freq * t + idx * np.sin(2 * np.pi * freq * 2.0 * t))
    sig += 0.25 * np.sin(2 * np.pi * freq * 2.0 * t) * np.exp(-t * 9)
    env = np.minimum(1, t / 0.003) * np.exp(-t * 7.5)
    return sig * env * vel * 0.5


def lead_note(freq, length, vel=1.0):
    t = t_of(length)
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.minimum(1, t / 0.25)
    sig = np.zeros_like(t)
    for h in range(1, 9):
        sig += np.sin(2 * np.pi * freq * vib * h * t + h) / h ** 1.4
    env = np.minimum(1, t / 0.012) * np.minimum(1, (length - t) / 0.05) * (0.6 + 0.4 * np.exp(-t * 4))
    return sig * env * vel * 0.28


def pad_chord(notes, length, bright_start=0.04, bright_end=1.0, swell=True):
    """additive saw pad; brightness (number of audible harmonics) and level rise over `length`"""
    t = t_of(length)
    out = np.zeros_like(t)
    prog = t / length
    bright = bright_start + (bright_end - bright_start) * prog ** 1.4
    for n in notes:
        for detune in (-0.09, 0.0, 0.09):
            f = midi(n + detune)
            for h in range(1, 14):
                w = 1.0 / h * np.clip(1.4 - h * (1.0 - bright) * 0.9, 0, 1) ** 2
                out += np.sin(2 * np.pi * f * h * t + h * 0.7 + n) * w
    env = (prog ** 1.6 if swell else 1.0) * np.minimum(1, (length - t) / 0.08)
    return out * env * 0.045


def chime(freq, length=4.0, vel=1.0):
    t = t_of(length)
    out = np.zeros_like(t)
    for ratio, amp, dec in [(1.0, 1.0, 1.1), (2.0, 0.55, 1.6), (2.76, 0.32, 2.6), (4.07, 0.2, 3.4), (5.4, 0.12, 4.5), (6.9, 0.07, 6.0)]:
        out += amp * np.sin(2 * np.pi * freq * ratio * t + 0.3 * ratio) * np.exp(-t * dec)
    out *= np.minimum(1, t / 0.002)
    return out * vel * 0.4


def swoosh(length=0.4, up=True, vel=1.0):
    t = t_of(length)
    n = rng.standard_normal(len(t))
    prog = t / length
    cutoff = (300 + 5200 * prog ** 2) if up else (5500 - 5000 * prog)
    y = lowpass(n, cutoff)
    env = np.sin(np.pi * np.clip(prog, 0, 1)) ** 1.5
    return y * env * vel * 1.4


def tick(vel=1.0):
    """soft interface click for a visual snapping into place"""
    t = t_of(0.07)
    return (np.sin(2 * np.pi * 1250 * t) * np.exp(-t * 110) * 0.6 + highpass(rng.standard_normal(len(t)), 2500) * np.exp(-t * 260) * 0.5) * vel


def key_click(vel=1.0, pitch=1.0):
    t = t_of(0.04)
    n = highpass(rng.standard_normal(len(t)), 1800) * np.exp(-t * 330)
    body = np.sin(2 * np.pi * 2300 * pitch * t) * np.exp(-t * 400) * 0.5
    return (n * 0.7 + body) * vel * 0.45


def riser(length):
    t = t_of(length)
    n = rng.standard_normal(len(t))
    prog = t / length
    y = lowpass(n, 400 + 9000 * prog ** 2.2)
    return y * prog ** 1.7


def reverse_cymbal(length):
    t = t_of(length)
    n = highpass(rng.standard_normal(len(t)), 3000)
    return n * (t / length) ** 3


# ---------------------------------------------------------------- arrangement
dry = Bus()      # drums, bass: no reverb
wet = Bus()      # pad, pluck, lead, chime: reverb
fx = Bus()       # swooshes, key clicks: light reverb

PROG = [  # per bar: (bass root, chord MIDI notes, arp scale notes)
    (33, [57, 60, 64, 67, 71], [57, 60, 64, 67]),   # Am9
    (29, [53, 57, 60, 64, 67], [53, 57, 60, 64]),   # Fmaj9
    (36, [55, 60, 64, 67, 71], [60, 64, 67, 72]),   # C
    (31, [55, 59, 62, 66, 69], [55, 59, 62, 67]),   # G
]
BEAT_IN = 3.0
PEAK_IN = 17.0
END_MUSIC = 22.9
BAR = BEAT * 4


def in_range(t, a, b):
    return a - 1e-6 <= t < b - 1e-6


# 0:00-0:03 swell; it carries on quietly under the beat and opens up for the peak
wet.add(0.0, pad_chord(PROG[0][1], 3.1), gain=2.2)
bar_idx = 0
t = BEAT_IN
while t < END_MUSIC - 1e-6:
    root, chord, arp = PROG[bar_idx % 4]
    length = min(BAR, END_MUSIC - t)
    level = 0.55 if t < PEAK_IN else 0.9
    wet.add(t, pad_chord(chord, length + 0.05, 0.55, 0.85, swell=False), gain=level * 0.8)
    # drums, beat by beat
    for b in range(4):
        tb = t + b * BEAT
        if tb >= END_MUSIC - 0.01:
            break
        peak = tb >= PEAK_IN
        early = tb < 9.0
        if b in (0, 2) or (not early) or peak:
            dry.add(tb, kick(1.0 if b == 0 else 0.85), gain=0.95)
        if (b in (1, 3)) and tb >= 5.0:
            dry.add(tb, clap(1.0), gain=0.55 if not peak else 0.7, pan=0.05)
        if tb >= 13.0 and b == 3:  # a ghost kick before the bar
            dry.add(tb + BEAT * 0.75, kick(0.5), gain=0.55)
        # hats: eighths, sixteenths in the peak
        step = BEAT / (4 if peak else 2)
        for k in range(int(BEAT / step)):
            th = tb + k * step
            if th >= END_MUSIC:
                break
            off = (k % 2 == 1)
            dry.add(th, hat(0.55 + 0.35 * off + 0.1 * rng.random(), open_=(off and not peak and b == 3)), gain=0.5 if not peak else 0.42, pan=-0.2 + 0.4 * off)
    # bass: from 0:05, syncopated
    if t >= 5.0:
        pat = [(0, 0.75), (1.5, 0.5), (2.5, 0.5), (3.25, 0.5)] if t >= PEAK_IN else [(0, 1.5), (2.5, 1.0)]
        for off_b, ln in pat:
            tb = t + off_b * BEAT
            if tb < END_MUSIC - 0.05:
                note = root + (12 if off_b in (1.5, 3.25) and t >= PEAK_IN else 0)
                dry.add(tb, bass_note(midi(note), ln * BEAT, 1.0), gain=0.7)
    # pluck arpeggio: from 0:07 eighths, sixteenths in the peak
    if t >= 7.0:
        div = 4 if t >= PEAK_IN else 2
        for k in range(4 * div):
            tb = t + k * BEAT / div
            if tb >= END_MUSIC - 0.05:
                break
            seq = arp if k % 8 < 4 else arp[::-1]
            note = seq[k % len(seq)] + (12 if (t >= 11.0 and (k // len(arp)) % 2 == 1) else 0)
            vel = 0.55 + 0.35 * (k % div == 0)
            wet.add(tb, pluck(midi(note + 12), 0.45, vel), gain=0.5 if t < PEAK_IN else 0.62, pan=-0.35 + 0.7 * ((k % 5) / 4))
    # lead hook in the peak (every other bar a short phrase)
    if t >= PEAK_IN:
        hook = [(0, 76, 0.5), (0.75, 79, 0.25), (1.0, 81, 0.5), (2.0, 79, 0.5), (2.75, 76, 0.25), (3.0, 74, 0.9)] if bar_idx % 2 == 0 else [(0, 72, 0.5), (0.75, 76, 0.25), (1.0, 79, 0.5), (2.0, 76, 0.5), (3.0, 71, 0.9)]
        for off_b, nt, ln in hook:
            tb = t + off_b * BEAT
            if tb < END_MUSIC - 0.1:
                wet.add(tb, lead_note(midi(nt), ln * BEAT, 1.0), gain=0.7, pan=0.1)
    t += BAR
    bar_idx += 1

# build into the montage: riser and snare roll (0:15 - 0:17), reverse cymbal into the chime
wet.add(15.0, riser(2.0), gain=0.22)
for k in range(16):
    tb = 16.0 + k * (BEAT / 4) * (1.0 if k < 8 else 1.0)
    dry.add(tb, snare_hit(0.35 + 0.65 * k / 15), gain=0.55)
wet.add(PEAK_IN - 0.02, swoosh(0.5, up=False), gain=0.35)
dry.add(PEAK_IN, kick(1.15), gain=1.0)
wet.add(22.0, reverse_cymbal(0.95), gain=0.28)
# last bar: stop the groove just before the chime
# final chime (one clean bell, a fifth above) on the end card
wet.add(TL["chime"], chime(midi(81), 4.2, 1.0), gain=0.8, pan=-0.1)
wet.add(TL["chime"] + 0.03, chime(midi(88), 3.6, 0.55), gain=0.55, pan=0.15)

# ---------------------------------------------------------------- typing, cuts and snaps (fx bus)
for tp in TL["typing"]:
    if not tp.get("sound"):
        continue
    for i, ch in enumerate(tp["text"]):
        if ch == " ":
            continue
        ts = tp["start"] + i / tp["cps"]
        if ts < DUR:
            fx.add(ts, key_click(0.55 + 0.4 * rng.random(), 0.9 + 0.25 * rng.random()), gain=0.5, pan=rng.uniform(-0.2, 0.2))
for ts in TL["snaps"]:
    fx.add(ts - 0.28, swoosh(0.34, up=True, vel=0.8), gain=0.32)
    fx.add(ts + 0.02, tick(0.9), gain=0.5)
# extra snaps: cards scaling and arranging inside the scenes
for ts, up in [(0.35, True), (3.1, True), (6.55, True), (10.55, True), (13.55, True), (17.6, True), (23.2, True)]:
    fx.add(ts, swoosh(0.45, up=up, vel=0.6), gain=0.22)
for ts in [13.9, 14.45, 15.0, 15.55, 16.05, 19.2, 20.7, 22.2]:
    fx.add(ts, tick(0.8), gain=0.45)

# ---------------------------------------------------------------- mix
IR = reverb_ir(1.8, 7)
wl = convolve(wet.l, IR)
wr = convolve(wet.r, reverb_ir(1.8, 11))
fl = convolve(fx.l, reverb_ir(0.7, 3))
fr = convolve(fx.r, reverb_ir(0.7, 5))

# gentle sidechain: duck the pad/pluck/bass on every kick of the groove
tt = np.arange(len(dry.l)) / SR
duck = np.ones_like(tt)
kt = BEAT_IN
while kt < END_MUSIC:
    sel = (tt >= kt) & (tt < kt + 0.35)
    duck[sel] = np.minimum(duck[sel], 1 - 0.38 * np.exp(-(tt[sel] - kt) / 0.09))
    kt += BEAT

mix_l = dry.l + (wl * 0.55 + wet.l * 0.55) * duck + fl * 0.5 + fx.l * 0.8
mix_r = dry.r + (wr * 0.55 + wet.r * 0.55) * duck + fr * 0.5 + fx.r * 0.8

# the chime and its tail are not ducked; the track ends in silence after it decays
mix = np.stack([mix_l, mix_r], axis=1)[:N]
mix = np.tanh(mix * 0.9) / np.tanh(0.9)
fade = np.ones(N)
fade[: int(0.02 * SR)] = np.linspace(0, 1, int(0.02 * SR))
tail_start = int((DUR - 1.0) * SR)
fade[tail_start:] = np.linspace(1, 0, N - tail_start)
mix *= fade[:, None]
peak = np.max(np.abs(mix))
mix = mix / peak * 0.89  # about -1 dBFS

out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "out" / "music.wav"
out.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(out), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
print("wrote", out, f"{len(mix) / SR:.2f}s", "peak", float(peak))
