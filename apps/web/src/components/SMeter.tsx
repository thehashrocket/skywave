import type { Meter } from "@/lib/use-radio";

// HF convention: S9 = -73 dBm, 6 dB per S-unit, so S1 = -121 dBm.
export function sUnits(dbm: number): string {
  if (dbm >= -73) {
    const over = Math.round((dbm + 73) / 10) * 10;
    return over > 0 ? `S9+${over}` : "S9";
  }
  return `S${Math.max(0, Math.min(9, Math.round((dbm + 127) / 6)))}`;
}

const MIN = -127;
const MAX = -33; // S9+40

export function SMeter({ meter }: { meter: Meter | null }) {
  const fill = meter ? Math.max(0, Math.min(1, (meter.rssi - MIN) / (MAX - MIN))) : 0;
  const s9 = (-73 - MIN) / (MAX - MIN);
  return (
    <div className="smeter" aria-live="off">
      <div className="smeter-reading">
        <span className="smeter-s">{meter ? sUnits(meter.rssi) : "S–"}</span>
        <span className="smeter-dbm">{meter ? `${meter.rssi.toFixed(0)} dBm` : "no signal"}</span>
        {meter?.overflow && <span className="smeter-ov">Receiver overloaded</span>}
      </div>
      <div
        className="smeter-track"
        role="meter"
        aria-label="Signal strength"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={meter?.rssi ?? MIN}
      >
        <div className="smeter-fill" style={{ transform: `scaleX(${fill})` }} />
        <div className="smeter-s9" style={{ left: `${s9 * 100}%` }} />
      </div>
      <div className="smeter-scale" aria-hidden="true">
        {[1, 3, 5, 7, 9].map((s) => (
          <span key={s} style={{ left: `${((-127 + s * 6 - MIN) / (MAX - MIN)) * 100}%` }}>
            {s}
          </span>
        ))}
        <span style={{ left: `${((-53 - MIN) / (MAX - MIN)) * 100}%` }}>+20</span>
        <span style={{ left: `${((-33 - MIN) / (MAX - MIN)) * 100}%` }}>+40</span>
      </div>
    </div>
  );
}
