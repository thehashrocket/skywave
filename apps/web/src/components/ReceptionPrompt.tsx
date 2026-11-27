"use client";

import { useState } from "react";
import { COMMENT_MAX, groupChoices, type GroupAnswer, type Outcome } from "@/lib/reception";
import type { ReceptionPromptData } from "@/lib/use-reception-prompt";

type Props = {
  prompt: ReceptionPromptData;
  /** Where the receiver is, as the list says; empty for one it doesn't know. */
  place: string;
  onAnswer: (outcome: Outcome, comment: string) => void;
  /** An answer to a shared-frequency question (#150): `prompt.tx.group` set. */
  onAnswerGroup: (answer: GroupAnswer, comment: string) => void;
  onClose: () => void;
};

const ANSWERS: { outcome: Outcome; label: string }[] = [
  { outcome: "heard", label: "Heard" },
  { outcome: "not_heard", label: "Not heard" },
  { outcome: "no_open", label: "Didn't open" },
];

/**
 * "Did you hear KBS World Radio on the receiver in Seoul on 9,580 kHz?": three
 * answers, an optional comment behind a link, and a ✕. On a frequency catalog
 * stations share (#150), "Which did you hear: WWV or WWVH …?" with a choice per
 * station, both, nothing, can't tell, and didn't open. Rendered on the line
 * the page reserves under the status row, so it never covers the dial or
 * moves the waterfall; listening carries on whatever it's answered.
 */
export function ReceptionPrompt({ prompt, place, onAnswer, onAnswerGroup, onClose }: Props) {
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const khz = prompt.freqKhz.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const where = place ? `the receiver in ${place}` : `the receiver at ${prompt.host}`;
  const { group } = prompt.tx;
  // A double click answers once.
  const button = (key: string, label: string, answer: () => void) => (
    <button
      key={key}
      type="button"
      className="link-button inline"
      onClick={(e) => {
        if (e.detail <= 1) answer();
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <span id="reception-question">
        {group
          ? `Which did you hear on ${where} on ${khz} kHz: ${prompt.tx.label}?`
          : `Did you hear ${prompt.tx.label} on ${where} on ${khz} kHz?`}
      </span>
      <span className="reception-answers" role="group" aria-labelledby="reception-question">
        {group
          ? groupChoices(group).map((c) =>
              button(typeof c.answer === "object" ? `heard:${c.answer.heard}` : c.answer, c.label, () =>
                onAnswerGroup(c.answer, comment),
              ),
            )
          : ANSWERS.map((a) => button(a.outcome, a.label, () => onAnswer(a.outcome, comment)))}
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
