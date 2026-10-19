"""Helpers shared by the offline scripts for reading and writing WAV files."""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np


def read_iq_wav(path: Path) -> tuple[np.ndarray, float]:
    """Load a stereo int16 I/Q WAV. Uses the exact rate from the .json sidecar if present."""
    with wave.open(str(path), "rb") as w:
        if w.getnchannels() != 2 or w.getsampwidth() != 2:
            raise SystemExit(f"{path} isn't a 16-bit stereo I/Q WAV")
        rate = float(w.getframerate())
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    sidecar = path.with_suffix(path.suffix + ".json")
    if sidecar.exists():
        rate = float(json.loads(sidecar.read_text()).get("sampleRate", rate))
    f = raw.astype(np.float32) / 32768.0
    return (f[0::2] + 1j * f[1::2]).astype(np.complex64), rate


def write_audio_wav(path: Path, audio: np.ndarray, rate: float) -> None:
    pcm = np.clip(audio * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(round(rate)))
        w.writeframes(pcm.tobytes())
