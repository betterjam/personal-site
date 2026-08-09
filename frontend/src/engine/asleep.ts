/**
 * THE ASLEEP LINE — one sentence, one link, written once.
 *
 * When the API cannot be reached the site keeps working from its bundled
 * snapshot (engine/snapshot.ts), and every surface that says so must say
 * the SAME thing: the infrastructure is asleep, what you are reading is
 * the last snapshot the repository published, and here is the window.
 * The hub banner, the blog's offline note and the page reading room all
 * build their line from here, so the wording can never drift between them.
 *
 * Deliberately calm and honest: nothing here implies live data, and
 * nothing here reads as an error. Sleeping is a feature of this site —
 * and the control plane is anonymous READ-ONLY (G8): anyone may watch
 * the infrastructure live; only the operator's token flips the switch.
 *
 * DOM only, textContent only — no HTML strings anywhere.
 */

/** The public control plane: the live window, read-only for visitors. */
export const CONTROL_URL = 'https://control.diegopalominos.dev';

/** What is true right now. */
export const ASLEEP_LEAD = 'The infrastructure is asleep.';

/** What the visitor is therefore reading. Never "live", because it is not. */
export const ASLEEP_SNAPSHOT =
  'You are reading the last snapshot this repo published.';

/** The invitation — to look, not to touch. */
export const ASLEEP_CTA = 'Watch it sleep, live, at control.diegopalominos.dev';

/** The short form, for places that already have a subject (the blog note). */
export const ASLEEP_SHORT = 'the infrastructure is asleep — showing the last published snapshot';

export interface AsleepNoteOptions {
  /** Class for the <p>; each finish styles its own. */
  className?: string;
  /** Sentence in front of the standard line, e.g. the blog's 'Showing drafts.' */
  lead?: string;
  /** Drop the snapshot sentence where the lead already made that point. */
  snapshot?: boolean;
}

/**
 * The line as a paragraph: lead, the standard sentences, then the control
 * link (a real anchor — new tab, rel=noopener, the arrow decorative).
 */
export function asleepNote(opts: AsleepNoteOptions = {}): HTMLParagraphElement {
  const p = document.createElement('p');
  if (opts.className) p.className = opts.className;

  const say = (text: string): void => {
    const span = document.createElement('span');
    span.className = 'asleep-say';
    span.textContent = text;
    p.appendChild(span);
  };

  if (opts.lead) say(opts.lead);
  say(ASLEEP_LEAD);
  if (opts.snapshot !== false) say(ASLEEP_SNAPSHOT);

  const a = document.createElement('a');
  a.className = 'asleep-link';
  a.href = CONTROL_URL;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = ASLEEP_CTA;
  const arrow = document.createElement('span');
  arrow.className = 'asleep-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '→';
  a.appendChild(arrow);
  p.appendChild(a);

  return p;
}

export default asleepNote;
