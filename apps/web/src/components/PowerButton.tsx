"use client";

/**
 * Listen/Stop: the receiver form's submit button. The header strip and the
 * sticky tuning bar (#90) both use this one, so they share the double-click
 * guard. `onPress` runs on a press that will submit, before the form does.
 */
export function PowerButton({ busy, onPress }: { busy: boolean; onPress?: () => void }) {
  return (
    <button
      type="submit"
      form="receiver-form"
      className={busy ? "power power-on" : "power"}
      onClick={(e) => {
        // Listen turns into Stop at once; the second click of a
        // double-click mustn't stop what the first one started.
        if (e.detail > 1) {
          e.preventDefault();
          return;
        }
        onPress?.();
      }}
    >
      {busy ? "Stop" : "Listen"}
    </button>
  );
}
