"use client";

import { useState } from "react";
import { COMMENT_MAX, type Outcome } from "@/lib/reception";
import type { ReceptionPromptData } from "@/lib/use-reception-prompt";

type Props = {
  prompt: ReceptionPromptData;
  /** Where the receiver is, as the list says; empty for one it doesn't know. */
  place: string;
  onAnswer: (outcome: Outcome, comment: string) => void;
  onClose: () => void;
};

const ANSWERS: { outcome: Outcome; label: string }[] = [
  { outcome: "heard", label: "Heard" },
  { outcome: "not_heard", label: "Not heard" },
  { outcome: "no_open", label: "Didn't open" },
];

/**
 * "Did you hear KBS World Radio on the receiver in Seoul on 9,580 kHz?": three
 * answers, an optional comment behind a link, and a ✕. Rendered on the line
 * the page reserves under the status row, so it never covers the dial or
 * moves the waterfall; listening carries on whatever it's answered.
 */
export function ReceptionPrompt({ prompt, place, onAnswer, onClose }: Props) {
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const khz = prompt.freqKhz.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const where = place ? `the receiver in ${place}` : `the receiver at ${prompt.host}`;

  return (
    <>
      <span id="reception-question">
        Did you hear {prompt.tx.label} on {where} on {khz} kHz?
      </span>
      <span className="reception-answers" role="group" aria-labelledby="reception-question">
        {ANSWERS.map((a) => (
          <button
            key={a.outcome}
            type="button"
            className="link-button inline"
            onClick={(e) => {
              if (e.detail <= 1) onAnswer(a.outcome, comment);
            }}
          >
            {a.label}
          </button>
        ))}
      </span>
      {commenting ? (
        <input
          className="reception-comment"
          type="text"
          aria-label="Comment (optional)"
          placeholder="Comment (optional)"
          maxLength={COMMENT_MAX}
          value={comment}
          autoFocus
          onChange={(e) => setComment(e.target.value)}
        />
      ) : (
        <button type="button" className="link-button inline" onClick={() => setCommenting(true)}>
          Add a comment
        </button>
      )}
      <button type="button" className="reception-close" aria-label="Close" onClick={onClose}>
        ✕
      </button>
    </>
  );
}
