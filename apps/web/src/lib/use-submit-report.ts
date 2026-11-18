"use client";

import { useMutation } from "@tanstack/react-query";
import { track } from "@vercel/analytics";
import { useCallback } from "react";
import { listenerId } from "./listener-id";
import type { Outcome } from "./reception";
import { useTRPC } from "./trpc";
import type { ReceptionPromptData } from "./use-reception-prompt";

/**
 * Sends a reception prompt's answer to `reports.submit`, and counts it in
 * Vercel Analytics as `reception_report` with the outcome only (no receiver,
 * station or comment). Fire and forget: over a rate limit the server quietly
 * declines, and a failed send isn't the listener's to fix, so neither shows.
 */
export function useSubmitReport() {
  const trpc = useTRPC();
  const { mutate } = useMutation(trpc.reports.submit.mutationOptions());
  return useCallback(
    (p: ReceptionPromptData, outcome: Outcome, comment: string) => {
      mutate({
        listenerId: listenerId(),
        receiverHost: p.host,
        receiverPort: p.port,
        freqKhz: p.freqKhz,
        mode: p.mode,
        txKind: p.tx.kind,
        txName: p.tx.name,
        txDetail: p.tx.detail,
        slotStartMs: p.tx.slotStartMs,
        outcome,
        comment,
      });
      track("reception_report", { outcome });
    },
    [mutate],
  );
}
