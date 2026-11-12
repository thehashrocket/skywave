"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { isMode, MODE_LABELS, type Mode } from "@/lib/radio-types";
import { sitePublic } from "@/lib/site";
import { useTRPC } from "@/lib/trpc";

type Props = {
  freqKhz: number;
  mode: Mode;
  onSelect: (p: { freqKhz: number; mode: Mode }) => void;
};

type Item = { id: string; name: string; freqKhz: number; mode: string; onDelete?: () => void };

// On a public site (lib/site) each browser keeps its own saved frequencies
// here, and the shared presets are read-only picks.
const LOCAL_KEY = "skywave.presets";
const LOCAL_MAX = 200;
type Local = { id: string; name: string; freqKhz: number; mode: Mode };

function loadLocal(): Local[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is Local =>
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.freqKhz === "number" &&
        Number.isFinite(p.freqKhz) &&
        isMode(p.mode),
    );
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
        [...local, { id, name: trimmedName.slice(0, 80), freqKhz, mode }]
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
  const shared: Item[] = (list.data ?? []).map((p) => ({
    ...p,
    onDelete: isPublic ? undefined : () => remove.mutate({ id: p.id }),
  }));

  const renderList = (items: Item[], label: string) => (
    <ul className="presets-list" aria-label={label}>
      {items.map((p) => {
        const current = Math.abs(p.freqKhz - freqKhz) < 0.005 && p.mode === mode;
        return (
          <li key={p.id} data-current={current || undefined}>
            <button
              type="button"
              className="preset-tune"
              onClick={() => onSelect({ freqKhz: p.freqKhz, mode: p.mode as Mode })}
            >
              <span className="preset-freq">{p.freqKhz.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
              <span className="preset-mode">{MODE_LABELS[p.mode as Mode] ?? p.mode}</span>
              <span className="preset-name">{p.name}</span>
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
