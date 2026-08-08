/**
 * HUB — the Seafoam Studio masthead + card grid, ported from the mockup as
 * the top hero band of the long scroll, plus the under-construction banner
 * strip that rides above the masthead (status dot, credit line, commit
 * chip, deploy feed, collapsible roadmap).
 *
 * THE ASLEEP LINE. Visitors can stop this site's infrastructure from
 * control.diegopalominos.dev — that is the point of the control plane, not
 * an outage. So when the API stops answering the banner gains ONE calm
 * line (engine/asleep.ts): the infrastructure is asleep, what you are
 * reading is the last snapshot the repo published, and here is the switch.
 * It appears and disappears live — engine/apiState.ts re-checks a sleeping
 * API on a modest interval (and never while the tab is hidden), and the
 * first successful read of any kind takes the line away without a reload.
 */
import '../styles/hub.css';
import { gsap } from 'gsap';
import {
  itemTagsOf,
  type ContentSection,
  type MetaInfo,
  type RoadmapItem,
  type SiteContent,
} from '../engine/data';
import { apiAsleep, onApiState, watchApi } from '../engine/apiState';
import { asleepNote } from '../engine/asleep';
import { pad2 } from '../engine/themes';
import type { SectionCtx, SectionInstance } from './types';

export const HUB_ID = 'home';
const HUB_THEME = 'seafoam-studio';

export interface HubOpts {
  roadmap: RoadmapItem[];
  /** Compile-time fallback stamp (vite define) for the commit chip. */
  buildInfo: { sha: string; builtAt: string };
  /** /api/meta — resolves null while the endpoint ships. */
  meta: Promise<MetaInfo | null>;
  /** Card click → tweened scroll + swarm morph to the section (main.ts). */
  onCardClick(sectionId: string, card: HTMLElement): void;
  /** Banner expanded/collapsed or async rows landed — refresh triggers. */
  onLayoutChange?(): void;
}

export interface HubInstance extends SectionInstance {
  /** Entrance elements in rise order — the banner rises first. */
  rise: HTMLElement[];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function relTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/** Card tags: inline items carry their own, page blocks carry theirs in
    content.json — itemTagsOf reads either shape, so the hub never has to
    resolve a page just to print three chips. */
function itemTags(section: ContentSection): string[] {
  const seen: string[] = [];
  for (const it of section.items) {
    for (const t of itemTagsOf(it)) {
      if (!seen.includes(t)) seen.push(t);
    }
  }
  return seen.slice(0, 3);
}

/* ------------------------------------------------------------- banner --- */

interface Banner {
  el: HTMLElement;
  /** Stop watching the API — the hub's destroy() calls it. */
  destroy(): void;
}

function buildBanner(opts: HubOpts): Banner {
  const banner = el('div', 'hb-banner');

  /* (a) status dot + copy */
  const status = el('p', 'hb-bn-status');
  const dot = el('i', 'hb-bn-dot');
  dot.setAttribute('aria-hidden', 'true');
  status.appendChild(dot);
  status.appendChild(
    el('span', 'hb-bn-copy', 'Under construction — new commits deploy straight here. Keep browsing.'),
  );
  banner.appendChild(status);

  /* (a2) …and, only while the API is not answering, the asleep line.
     Same words everywhere on the site: engine/asleep.ts owns them. */
  const asleep = asleepNote({ className: 'hb-bn-asleep' });
  asleep.hidden = !apiAsleep();
  banner.appendChild(asleep);

  function syncAsleep(): void {
    const hide = !apiAsleep();
    if (asleep.hidden === hide) return;
    asleep.hidden = hide;
    /* the banner just changed height — the deck re-measures its slots */
    opts.onLayoutChange?.();
  }
  const unsubscribe = onApiState(syncAsleep);
  /* polite recovery watch: idle while the API is live or the tab is away */
  const unwatch = watchApi();

  /* (b) the credit, quiet and small */
  banner.appendChild(
    el(
      'p',
      'hb-bn-credit',
      'Diego on lead, Claude on rhythm — every riff below was committed by an AI with good taste in finishes.',
    ),
  );

  /* (c) commit chip: /api/meta when it lands, build stamp until then */
  const chip = el('span', 'hb-bn-chip');
  function setChip(sha: string, builtAt: string): void {
    chip.textContent = `${shortSha(sha)} · ${relTime(builtAt)}`;
    chip.title = builtAt;
  }
  setChip(opts.buildInfo.sha, opts.buildInfo.builtAt);
  banner.appendChild(chip);

  /* (d) recent updates — the deploy feed is event-sourced server-side */
  const deploys = el('div', 'hb-bn-deploys');
  deploys.hidden = true;
  deploys.appendChild(el('span', 'hb-bn-deploys-label', 'recent updates'));
  banner.appendChild(deploys);

  void opts.meta.then((meta) => {
    if (!meta) return;
    setChip(meta.commit, meta.builtAt);
    const rows = [...meta.deploys]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 3);
    if (rows.length) {
      for (const row of rows) {
        const line = el('span', 'hb-bn-deploy');
        line.appendChild(el('span', 'sha', shortSha(row.sha)));
        line.appendChild(el('span', 'when', relTime(row.at)));
        line.title = row.at;
        deploys.appendChild(line);
      }
      deploys.hidden = false;
    }
    opts.onLayoutChange?.();
  });

  /* (e) the todos — collapsible roadmap grouped done / doing / next */
  const order: Record<RoadmapItem['status'], number> = { done: 0, doing: 1, next: 2 };
  const items = [...opts.roadmap].sort((a, b) => order[a.status] - order[b.status]);
  const counts = { done: 0, doing: 0, next: 0 };
  for (const it of items) counts[it.status] += 1;

  const todos = el('details', 'hb-bn-todos');
  const summary = el(
    'summary',
    null,
    `the todos — ${counts.done} done · ${counts.doing} doing · ${counts.next} next`,
  );
  todos.appendChild(summary);
  const list = el('ul', 'hb-td-list');
  for (const it of items) {
    const li = el('li', `hb-td-item is-${it.status}`);
    const mark = el('i', `hb-td-mark is-${it.status}`);
    mark.setAttribute('aria-hidden', 'true');
    li.appendChild(mark);
    li.appendChild(el('span', 'hb-td-title', it.title));
    li.appendChild(el('span', 'mx-sr', ` — ${it.status}`));
    list.appendChild(li);
  }
  todos.appendChild(list);
  todos.addEventListener('toggle', () => opts.onLayoutChange?.());
  banner.appendChild(todos);

  return {
    el: banner,
    destroy() {
      unsubscribe();
      unwatch();
    },
  };
}

/* ---------------------------------------------------------------- hub --- */

export function buildHub(
  host: HTMLElement,
  data: SiteContent,
  ctx: SectionCtx,
  opts: HubOpts,
): HubInstance {
  const profile = data.profile;
  const sections = data.sections;

  const wrap = el('section', 'vw vw-hub');
  wrap.id = 'vw-' + HUB_ID;
  ctx.applyTokens(wrap, HUB_THEME, ctx.accentOf(HUB_THEME, null));

  const col = el('div', 'mx-col');
  wrap.appendChild(col);

  /* under-construction banner rides above the masthead */
  const banner = buildBanner(opts);
  col.appendChild(banner.el);

  const mast = el('div', 'hb-masthead');
  const name = el('h1', 'hb-name', profile.name);
  name.id = 'hl-' + HUB_ID;
  wrap.setAttribute('aria-labelledby', name.id);
  mast.appendChild(name);

  const aside = el('div', 'hb-aside');
  aside.appendChild(el('p', 'hb-role', profile.role));
  aside.appendChild(el('p', 'hb-tagline', profile.tagline));
  if (profile.credential) aside.appendChild(el('p', 'hb-degree', profile.credential));
  mast.appendChild(aside);

  const coords = el('p', 'hb-coords');
  coords.appendChild(el('span', null, `${sections.length} sections`));
  const cmail = el('a', 'hb-link', profile.contact);
  cmail.href = 'mailto:' + profile.contact;
  coords.appendChild(cmail);
  coords.appendChild(el('span', null, profile.location));
  for (const lnk of profile.links ?? []) {
    const a = el('a', 'hb-link', lnk.label);
    a.href = lnk.url;
    a.target = '_blank';
    a.rel = 'noopener';
    coords.appendChild(a);
  }
  /* the career record, first-class on the masthead: the experience page is
     an internal route (same tab), the ATS résumé is the file itself */
  const cexp = el('a', 'hb-link', 'Experience');
  cexp.href = '#/page/experience';
  coords.appendChild(cexp);
  const ccv = el('a', 'hb-link', 'Résumé (PDF)');
  ccv.href = '/resume.pdf';
  ccv.target = '_blank';
  ccv.rel = 'noopener';
  coords.appendChild(ccv);
  mast.appendChild(coords);
  col.appendChild(mast);

  const grid = el('div', 'hb-grid');
  const rise: HTMLElement[] = [banner.el, aside, coords];
  sections.forEach((s, i) => {
    const variant =
      s.id === 'guitars' ? 'hb-card--pine' : s.id === 'blog' ? 'hb-card--seafoam' : 'hb-card--bone';
    const card = el('button', 'hb-card ' + variant);
    card.type = 'button';
    card.setAttribute('aria-label', s.label);
    card.appendChild(el('span', 'hb-kicker', s.kicker));
    card.appendChild(el('span', 'hb-label', s.label));
    const meta = el('span', 'hb-meta');
    const tags = el('span', 'hb-tags');
    for (const t of itemTags(s)) tags.appendChild(el('span', null, t));
    meta.appendChild(tags);
    meta.appendChild(el('span', 'hb-count', `${pad2(i + 1)} · ${s.items.length} items`));
    card.appendChild(meta);
    card.addEventListener('click', () => opts.onCardClick(s.id, card));
    grid.appendChild(card);
    rise.push(card);
  });
  col.appendChild(grid);

  host.appendChild(wrap);

  /* ------------------------------ entrance ------------------------------
     The FIRST paint is the particle intro (owned by main.ts). Every later
     landing replays the rise: banner first, then aside/coords/cards. */

  return {
    el: wrap,
    headline: name,
    rise,
    prepareEntrance() {
      if (ctx.reduced()) return;
      gsap.killTweensOf(rise);
      gsap.set(rise, { autoAlpha: 0, y: 22 });
    },
    playEntrance() {
      gsap.killTweensOf(rise);
      if (ctx.reduced()) {
        gsap.set(rise, { clearProps: 'opacity,visibility,transform' });
        return;
      }
      gsap.to(rise, {
        autoAlpha: 1,
        y: 0,
        duration: 0.55,
        stagger: 0.05,
        ease: 'power2.out',
        delay: 0.3,
        clearProps: 'opacity,visibility,transform',
      });
    },
    destroy() {
      gsap.killTweensOf(rise);
      banner.destroy();
    },
  };
}
