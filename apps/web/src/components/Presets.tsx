"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { isMode, MODE_LABELS, type Mode } from "@/lib/radio-types";
import { serverNow } from "@/lib/server-clock";
import { sitePublic } from "@/lib/site";
import { useTRPC } from "@/lib/trpc";
import { useServerTick } from "@/lib/use-server-tick";
import { savedLabel, savedTitle } from "@/lib/utc-time";

type Props = {
  freqKhz: number;
  mode: Mode;
  onSelect: (p: { freqKhz: number; mode: Mode }) => void;
};

type Item = { id: string; name: string; freqKhz: number; mode: string; savedAt?: number; onDelete?: () => void };

// On a public site (lib/site) each browser keeps its own saved frequencies
// here, and the shared presets are read-only picks.
const LOCAL_KEY = "skywave.presets";
const LOCAL_MAX = 200;
/** `savedAt`: when it was saved, ms since the epoch on the server's clock (#107); none for entries saved before. */
type Local = { id: string; name: string; freqKhz: number; mode: Mode; savedAt?: number };

/** No save is older than the stamps themselves (#107, 2026): 0 or a negative number is a bad value, not 1970. */
const EARLIEST_SAVED_AT = Date.UTC(2026, 0, 1);

/** A time `new Date` can hold (finite isn't enough: 1e20 is an Invalid Date, and formatting it throws), and no earlier than the stamps. */
const isSavedAt = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(new Date(v).getTime()) && v >= EARLIEST_SAVED_AT;

/**
 * The browser's list, each entry rebuilt from the fields it should have, so a
 * bad `savedAt` is dropped (the entry kept, with no stamp) and not written back.
 */
function loadLocal(): Local[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((p: unknown) => {
      if (typeof p !== "object" || p === null) return [];
      const { id, name, freqKhz, mode, savedAt } = p as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string" || typeof freqKhz !== "number") return [];
      if (!Number.isFinite(freqKhz) || !isMode(mode)) return [];
      const entry: Local = { id, name, freqKhz, mode };
      if (isSavedAt(savedAt)) entry.savedAt = savedAt;
      return [entry];
    });
  } catch {
    return [];
  }
}

function saveLocal(list: Local[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable; the list still shows this visit */
  }
}

export function Presets({ freqKhz, mode, onSelect }: Props) {
  const isPublic = sitePublic();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useQuery(trpc.presets.list.queryOptions());
  const invalidate = () => queryClient.invalidateQueries({ queryKey: trpc.presets.list.queryKey() });
  const create = useMutation(trpc.presets.create.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.presets.delete.mutationOptions({ onSuccess: invalidate }));
  const [local, setLocal] = useState<Local[]>([]);
  useEffect(() => {
    if (isPublic) setLocal(loadLocal());
  }, [isPublic]);
  const updateLocal = (next: Local[]) => {
    setLocal(next);
    saveLocal(next);
  };
  const [name, setName] = useState("");
  const trimmedName = name.trim();

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmedName) return;
    if (isPublic) {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      updateLocal(
        [...local, { id, name: trimmedName.slice(0, 80), freqKhz, mode, savedAt: serverNow() }]
          .sort((a, b) => a.freqKhz - b.freqKhz)
          .slice(0, LOCAL_MAX),
      );
      setName("");
      return;
    }
    create.mutate({ name: trimmedName, freqKhz, mode }, { onSuccess: () => setName("") });
  };

  const mine: Item[] = local.map((p) => ({
    ...p,
    onDelete: () => updateLocal(local.filter((q) => q.id !== p.id)),
  }));
  // Shared presets carry no stamp, public or private: only a save this browser made says when it was heard.
  const shared: Item[] = (list.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    freqKhz: p.freqKhz,
    mode: p.mode,
    onDelete: isPublic ? undefined : () => remove.mutate({ id: p.id }),
  }));
  // The stamps' "now", for the weekday-or-date rule: ticks once a minute, so a
  // stamp moves from weekday to date by itself, and render never reads the clock.
  // Null until mounted, which is also when the browser's list loads, and on a
  // private site, where no row is stamped.
  const now = useServerTick(60_000, isPublic);

  const renderList = (items: Item[], label: string) => (
    <ul className="presets-list" aria-label={label}>
      {items.map((p) => {
        const current = Math.abs(p.freqKhz - freqKhz) < 0.005 && p.mode === mode;
        // The stamp is the button's description, not part of its name.
        const stampId = p.savedAt === undefined || now === null ? undefined : `preset-saved-${p.id}`;
        return (
          <li key={p.id} data-current={current || undefined}>
            <button
              type="button"
              className="preset-tune"
              aria-current={current || undefined}
              aria-describedby={stampId}
              onClick={() => onSelect({ freqKhz: p.freqKhz, mode: p.mode as Mode })}
            >
              <span className="preset-freq">{p.freqKhz.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
              <span className="preset-mode">{MODE_LABELS[p.mode as Mode] ?? p.mode}</span>
              <span className="preset-what">
                <span className="preset-name">{p.name}</span>
                {stampId !== undefined && p.savedAt !== undefined && now !== null && (
                  <span id={stampId} className="preset-saved" aria-hidden="true" title={savedTitle(p.savedAt)}>
                    {savedLabel(p.savedAt, now)}
                  </span>
                )}
              </span>
            </button>
            {p.onDelete && (
              <button type="button" className="preset-delete" aria-label={`Delete ${p.name}`} onClick={p.onDelete}>
                ×
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <section className="presets" aria-labelledby="presets-heading">
      <h2 id="presets-heading">Saved frequencies</h2>

      {isPublic && mine.length > 0 && renderList(mine, "Yours")}
      {isPublic && mine.length === 0 && (
        <p className="presets-note">Tune somewhere good and save it below. It stays in this browser.</p>
      )}

      {isPublic && shared.length > 0 && <h3 className="presets-subhead">Worth a listen</h3>}
      {list.isPending && <p className="presets-note">Loading…</p>}
      {list.isError && (
        <p className="presets-note">
          {isPublic
            ? "Couldn't load the suggestions."
            : "Couldn't load saved frequencies. Check DATABASE_URL and that the migration has run."}
        </p>
      )}
      {!isPublic && list.data?.length === 0 && (
        <p className="presets-note">Nothing saved yet. Tune somewhere good and save it below.</p>
      )}
      {shared.length > 0 && renderList(shared, isPublic ? "Worth a listen" : "Saved")}
      {remove.isError && <p className="presets-note">Couldn't delete that. Is the database running?</p>}

      <form className="presets-save" onSubmit={save}>
        <label htmlFor="preset-name">
          Save {freqKhz.toLocaleString("en-US", { maximumFractionDigits: 2 })} kHz {MODE_LABELS[mode]} as
        </label>
        <div className="presets-save-row">
          <input
            id="preset-name"
            value={name}
            maxLength={80}
            placeholder="e.g. Radio New Zealand, evenings"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={!trimmedName || create.isPending}>
            Save
          </button>
        </div>
        {create.isError && <p className="presets-note">Couldn't save that. Is the database running?</p>}
      </form>
    </section>
  );
}
