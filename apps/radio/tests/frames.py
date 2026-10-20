"""Decoders for the radio service's binary frames, shared by the tests."""

import numpy as np

from skywave_radio.dsp import SPECTRUM_STEP_DB


def decode_spectrum(payload: bytes) -> np.ndarray:
    """A 0x04 payload (after the tag): float32 LE base dB, then one uint8 per bin."""
    base = np.frombuffer(payload[:4], dtype="<f4")[0]
    return base + np.frombuffer(payload[4:], dtype=np.uint8) * SPECTRUM_STEP_DB
