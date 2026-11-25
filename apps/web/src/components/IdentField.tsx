"use client";

import { useEffect, useId, useState } from "react";
import { IDENT_MAX, identProblem, identShown, loadIdent, normalizeIdent, saveIdent } from "@/lib/listener-ident";

/**
 * The listener's call sign or name, shown on receivers' user lists instead
 * of Skywave's (issue #108). Saved in this browser as it's typed, when usable;
 * used from the next receiver that connects.
 */
export function IdentField() {
  const id = useId();
  const [value, setValue] = useState("");
  // False once a usable name couldn't be stored (site data blocked): tunes
  // read it from storage, so it would never reach a receiver.
  const [saved, setSaved] = useState(true);
  // Read after mount: the server render has no storage.
  useEffect(() => setValue(loadIdent() ?? ""), []);
  const problem = identProblem(value);
  const name = normalizeIdent(value);

  return (
    <div className="field ident-field">
      <label htmlFor={id}>Your call sign or name</label>
      <input
        id={id}
        value={value}
        maxLength={IDENT_MAX + 8}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem !== null}
        aria-describedby={`${id}-note`}
        onChange={(e) => {
          setValue(e.target.value);
          const usable = saveIdent(e.target.value);
          const name = normalizeIdent(e.target.value);
          setSaved(!usable || !name || loadIdent() === name);
        }}
      />
      <p id={`${id}-note`} className="ident-note">
        {problem ??
          (name && !saved
            ? "This browser isn't saving site data, so receivers will show Skywave's own name instead."
            : name
              ? `From your next Listen, receivers show you as “${identShown(name)}” (some allow more or fewer characters). Their owners and other listeners there can see it.`
              : "Optional. Shown on the receiver's user list, where its owner and other listeners can see it.")}
      </p>
    </div>
  );
}
