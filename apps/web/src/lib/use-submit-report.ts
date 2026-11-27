"use client";

import { useMutation } from "@tanstack/react-query";
import { track } from "@vercel/analytics";
import { useCallback } from "react";
import { listenerId } from "./listener-id";
import type { PickContext } from "./pick-context";
import type { GroupAnswer, Outcome } from "./reception";
import { useTRPC } from "./trpc";
import type { ReceptionPromptData } from "./use-reception-prompt";

/**
 * Sends a reception prompt's answer to `reports.submit`, and counts it in
 * Vercel Analytics as `reception_report` with the outcome only (no receiver,
 * station or comment). Fire and forget: over a rate limit the server quietly
 * declines, and a failed send isn't the listener's to fix, so neither shows.
 *
 * `pick` says how Pick best chose the receiver (issue #61), when it did.
 */
export function useSubmitReport() {
  const trpc = useTRPC();
  const { mutate } = useMutation(trpc.reports.submit.mutationOptions());
  return useCallback(
    (p: ReceptionPromptData, outcome: Outcome, comment: string, pick?: PickContext) => {
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
        askRule: p.tx.askRule,
        askRegion: p.tx.askRegion,
        outcome,
        comment,
        pick,
      });
      track("reception_report", { outcome });
    },
    [mutate],
  );
}

/**
 * Sends a shared-frequency answer (#150) to `reports.submitGroup`, which files
 * one report per station it names; "can't tell" files nothing and sends
 * nothing. Counted in Vercel Analytics as `reception_report` with the answer
 * only ("heard_one" for a single station heard). Returns whether it sent.
 */
export function useSubmitGroupReport() {
  const trpc = useTRPC();
  const { mutate } = useMutation(trpc.reports.submitGroup.mutationOptions());
  return useCallback(
    (p: ReceptionPromptData, answer: GroupAnswer, comment: string, pick?: PickContext): boolean => {
      if (!p.tx.group) return false;
      track("reception_report", { outcome: typeof answer === "object" ? "heard_one" : answer, group: true });
      if (answer === "unsure") return false;
      mutate({
        listenerId: listenerId(),
        receiverHost: p.host,
        receiverPort: p.port,
        freqKhz: p.freqKhz,
        mode: p.mode,
        stations: p.tx.group.map((m) => ({ slug: m.slug, ...(m.slotStartMs !== undefined && { slotStartMs: m.slotStartMs }) })),
        answer,
        comment,
        pick,
      });
      return true;
    },
    [mutate],
  );
}
