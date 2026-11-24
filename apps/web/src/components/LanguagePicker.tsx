"use client";

import { useEffect, useId, useRef, useState } from "react";
import { type LanguageChoice, pickedNames } from "@/lib/eibi";
import { fold } from "@/lib/station-search";

type Props = {
  /** The schedule's languages, common first (languageChoices). */
  choices: readonly LanguageChoice[];
  /** The codes picked; none is Any. */
  picked: readonly string[];
  onChange: (codes: string[]) => void;
  disabled: boolean;
};

const isPicked = (c: LanguageChoice, picked: readonly string[]) => c.codes.some((code) => picked.includes(code));

/** The button's words: "Any language", "English", "English, Spanish", "English, Spanish +3". */
export function pickedSummary(choices: readonly LanguageChoice[], picked: readonly string[]): string {
  const names = pickedNames(choices, picked);
  if (names.length === 0) return "Any language";
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
}

/**
 * The language filter of Find a station (#110, design 3A, 4A, 8A): a button
 * naming the picks that opens a panel with a filter field and a checkbox per
 * language. The picks as they were on opening come first, so ones hidden
 * behind "+3" can be seen and unticked; ticking doesn't move rows while it's
 * open, and a stale pick (eng D8) stays listed, unticked, until it closes.
 * Escape, a click outside or focus leaving it closes it, and Escape puts focus
 * back on the button. It floats over the list on wide screens and opens in place on
 * phones (CSS).
 */
export function LanguagePicker({ choices, picked, onChange, disabled }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState<readonly string[]>([]);
  // Stale picks as they were on opening: unticking one drops it from `choices`, not from the open panel.
  const [staleAtOpen, setStaleAtOpen] = useState<readonly LanguageChoice[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const toggleOpen = () => {
    if (open) return setOpen(false);
    setPinned(pickedNames(choices, picked));
    setStaleAtOpen(choices.filter((c) => c.stale));
    setText("");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    filterRef.current?.focus();
    const away = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const listed = [...choices, ...staleAtOpen.filter((s) => !choices.some((c) => c.name === s.name))];
  const words = fold(text.trim());
  const shown = words ? listed.filter((c) => fold(c.name).includes(words)) : listed;
  const top = shown.filter((c) => pinned.includes(c.name));
  const rest = shown.filter((c) => !pinned.includes(c.name));

  const set = (c: LanguageChoice, on: boolean) =>
    onChange(on ? [...new Set([...picked, ...c.codes])] : picked.filter((code) => !c.codes.includes(code)));

  const box = (c: LanguageChoice) => (
    <label key={c.name} className="check language-option">
      <input type="checkbox" checked={isPicked(c, picked)} onChange={(e) => set(c, e.target.checked)} />
      {c.name}
      {c.stale && <span className="language-stale">none in this schedule</span>}
    </label>
  );

  return (
    <div
      ref={rootRef}
      className="field language-picker"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
      onBlur={(e) => {
        // Tabbing past the last language closes the panel instead of leaving it over the list.
        if (open && e.relatedTarget && !rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <label htmlFor={`${id}-button`}>Languages</label>
      <button
        ref={buttonRef}
        id={`${id}-button`}
        type="button"
        className="select-button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        disabled={disabled}
        onClick={toggleOpen}
      >
        {pickedSummary(choices, picked)}
      </button>
      {open && (
        <div id={`${id}-panel`} className="language-panel">
          <div className="field">
            <label htmlFor={`${id}-filter`}>Filter languages</label>
            <input
              ref={filterRef}
              id={`${id}-filter`}
              type="search"
              value={text}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <fieldset className="language-options">
            <legend className="visually-hidden">Languages</legend>
            {top.map(box)}
            {top.length > 0 && rest.length > 0 && <hr className="language-rule" />}
            {rest.map(box)}
            {shown.length === 0 && <p className="presets-note">No language matches “{text.trim()}”.</p>}
          </fieldset>
        </div>
      )}
    </div>
  );
}
