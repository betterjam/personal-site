/**
 * THE CONTRACT between the app shell (main.ts) and section renderers.
 * Porter agents replacing the stubs build against this file — keep it clean.
 *
 * DECK MODEL: every view is a fixed, viewport-filling panel (its own
 * overflow-y:auto scroller); exactly one is displayed at a time and the
 * particle morph carries the eye between them. A section module exports
 * one SectionBuilder. The builder:
 *   - creates its view root as a <section aria-labelledby="..."> element,
 *     applies its theme's scoped tokens via ctx.applyTokens, appends the
 *     view to `host`, and returns a SectionInstance;
 *   - does NOT animate at build time — the deck drives the lifecycle:
 *     prepareEntrance() right before the view lands (seed hidden states),
 *     playEntrance() when it lands (play the choreography);
 *   - never touches its own headline's opacity/visibility — the deck owns
 *     the headline (it is the particle morph's anchor: the swarm shatters
 *     from the outgoing headline and converges on the incoming one);
 *   - styles exclusively through the scoped custom properties (--p-*,
 *     --accent, --focus, font tokens). No hardcoded palette hex anywhere.
 */
import type { ContentSection, MixtapeSection, ThemeSpec } from '../engine/data';

export interface SectionCtx {
  /** Live prefers-reduced-motion check — consult before ANY tween/loop. */
  reduced(): boolean;
  /**
   * Apply a theme's scoped tokens (--p-<kebab-token> for every palette
   * entry, --font-display/--font-body/--font-mono, --accent, --focus)
   * to a wrapper element. The wrapper is the cascade boundary.
   */
  applyTokens(node: HTMLElement, themeId: string, accentHex: string): void;
  /** The accent hex for a theme, honoring per-section overrides. */
  accentOf(themeId: string, sectionId?: string | null): string;
  /** The stage (background) hex for a theme. */
  stageOf(themeId: string): string;
  /** Silkscreen abbreviation for knob/jack labels (ACL, RCNCLTN, ...). */
  abbr(title: string): string;
  /** All six theme specs, keyed by theme id. */
  themes: Record<string, ThemeSpec>;
  /** This section's mixtape composition entry (theme + renderer + note). */
  mix: MixtapeSection;
}

export interface SectionInstance {
  /** The view root — a <section aria-labelledby> appended to the host. */
  el: HTMLElement;
  /** The view's main heading — the particle morph's anchor (deck-owned). */
  headline: HTMLElement;
  /**
   * Reset the entrance choreography to its hidden pre-entrance state.
   * Called by the deck at the swap (the view just became displayed, the
   * swarm still covers it). Must kill any running entrance tweens. No-op
   * under reduced motion (nothing is ever hidden there). Re-runnable —
   * views land many times.
   */
  prepareEntrance(): void;
  /**
   * Play the entrance choreography — invoked when the view lands (the
   * swarm has converged). Idempotent: kill running tweens first, then
   * play from the current state. Under reduced motion settle everything
   * instant-visible (gsap.set, never a tween).
   */
  playEntrance(): void;
  /** View became the displayed view — resume loops/tickers. */
  onEnter?(): void;
  /** View left the deck's front — pause loops/tickers. */
  onLeave?(): void;
  /** Kill tweens, timers and listeners this section created. */
  destroy?(): void;
}

export type SectionBuilder = (
  host: HTMLElement,
  section: ContentSection,
  index: number,
  ctx: SectionCtx,
) => SectionInstance;

/**
 * The shared 'Read the full page' link every section band renders right
 * after its summary. Category page slugs equal section ids, so the href
 * targets the existing '#/page/:slug' reading-room overlay — no router
 * work here. Styled once in base.css (.mx-bandlink) through the band's
 * scoped tokens only (--font-mono, --accent, --focus).
 */
export function pageLink(sectionId: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'mx-bandlink';
  a.href = '#/page/' + encodeURIComponent(sectionId);
  a.textContent = 'Read the full page';
  const arrow = document.createElement('span');
  arrow.className = 'mx-bandlink-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '→';
  a.appendChild(arrow);
  return a;
}
