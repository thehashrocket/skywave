"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { MODE_LABELS, type Mode } from "@/lib/radio-types";
import { useTRPC } from "@/lib/trpc";

type Props = {
  freqKhz: number;
  mode: Mode;
  onSelect: (p: { freqKhz: number; mode: Mode }) => void;
};

export function Presets({ freqKhz, mode, onSelect }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useQuery(trpc.presets.list.queryOptions());
  const invalidate = () => queryClient.invalidateQueries({ queryKey: trpc.presets.list.queryKey() });
  const create = useMutation(trpc.presets.create.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.presets.delete.mutationOptions({ onSuccess: invalidate }));
  const [name, setName] = useState("");

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), freqKhz, mode }, { onSuccess: () => setName("") });
  };

  return (
    <section className="presets" aria-labelledby="presets-heading">
      <h2 id="presets-heading">Saved frequencies</h2>

      {list.isPending && <p className="presets-note">Loading…</p>}
      {list.isError && (
        <p className="presets-note">
          Couldn't load saved frequencies. Check DATABASE_URL and that the migration has run.
        </p>
      )}
      {list.data?.length === 0 && (
        <p className="presets-note">Nothing saved yet. Tune somewhere good and save it below.</p>
      )}

      {list.data && list.data.length > 0 && (
        <ul className="presets-list">
          {list.data.map((p) => {
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
                <button
                  type="button"
                  className="preset-delete"
                  aria-label={`Delete ${p.name}`}
                  onClick={() => remove.mutate({ id: p.id })}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
          <button type="submit" disabled={!name.trim() || create.isPending}>
            Save
          </button>
        </div>
        {create.isError && <p className="presets-note">Couldn't save that. Is the database running?</p>}
      </form>
    </section>
  );
}
