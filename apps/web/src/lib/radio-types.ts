export const MODES = ["am", "usb", "lsb", "cw"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = { am: "AM", usb: "USB", lsb: "LSB", cw: "CW" };

/** Audio passband relative to the tuned frequency, in Hz. Mirrors apps/radio/skywave_radio/dsp.py. */
export const PASSBANDS: Record<Mode, [number, number]> = {
  am: [-4500, 4500],
  usb: [300, 2700],
  lsb: [-2700, -300],
  cw: [450, 950],
};

/** Sensible default mode for a frequency: hams use LSB below 10 MHz, USB above; broadcasters are AM. */
export function guessMode(freqKhz: number): Mode {
  const inHamVoice = HAM_BANDS.some((b) => freqKhz >= b.startKhz && freqKhz <= b.endKhz);
  if (!inHamVoice) return "am";
  return freqKhz < 10_000 ? "lsb" : "usb";
}

export type Band = { name: string; startKhz: number; endKhz: number };

/** HF broadcast bands (ITU, approximate edges). */
export const BROADCAST_BANDS: Band[] = [
  { name: "120m", startKhz: 2300, endKhz: 2495 },
  { name: "90m", startKhz: 3200, endKhz: 3400 },
  { name: "75m", startKhz: 3900, endKhz: 4000 },
  { name: "60m", startKhz: 4750, endKhz: 5060 },
  { name: "49m", startKhz: 5900, endKhz: 6200 },
  { name: "41m", startKhz: 7200, endKhz: 7450 },
  { name: "31m", startKhz: 9400, endKhz: 9900 },
  { name: "25m", startKhz: 11600, endKhz: 12100 },
  { name: "22m", startKhz: 13570, endKhz: 13870 },
  { name: "19m", startKhz: 15100, endKhz: 15800 },
  { name: "16m", startKhz: 17480, endKhz: 17900 },
  { name: "15m", startKhz: 18900, endKhz: 19020 },
  { name: "13m", startKhz: 21450, endKhz: 21850 },
  { name: "11m", startKhz: 25670, endKhz: 26100 },
];

/** US amateur HF allocations. */
export const HAM_BANDS: Band[] = [
  { name: "160m", startKhz: 1800, endKhz: 2000 },
  { name: "80m", startKhz: 3500, endKhz: 4000 },
  { name: "40m", startKhz: 7000, endKhz: 7300 },
  { name: "30m", startKhz: 10100, endKhz: 10150 },
  { name: "20m", startKhz: 14000, endKhz: 14350 },
  { name: "17m", startKhz: 18068, endKhz: 18168 },
  { name: "15m", startKhz: 21000, endKhz: 21450 },
  { name: "12m", startKhz: 24890, endKhz: 24990 },
  { name: "10m", startKhz: 28000, endKhz: 29700 },
];

export const DIAL_MIN_KHZ = 0;
export const DIAL_MAX_KHZ = 30_000;
