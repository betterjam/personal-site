/**
 * PAGE READING ROOM — the #/page/:slug overlay in the SEAFOAM STUDIO
 * finish: bone walls, graphite ink, one perfect green. Deliberately a
 * different animal from the Sunburst posts room — no dark masthead, just
 * a strict Swiss rule, a quiet 'page' kicker and enormous Archivo.
 *
 * Mechanics mirror the blog reading room and the maintainer console: the
 * room lives on document.body (the deck hides inactive views with
 * display:none), wears its own copy of the Seafoam tokens via
 * applyTokens, and while open locks BOTH the body (the deck track) and
 * the active view's inner scroller. Escape and the close control return
 * to '#'; focus moves into the overlay on open and back to the trigger
 * on close; deep links work on initial page load (deferred a microtask
 * so the deck can seat the scrollbar first).
 *
 * The body renders through the strict-subset markdown engine — built
 * DOM, textContent only, no HTML pass-through. fetchPage resolves null
 * on 404 → an honest 'page not found'. '!page[slug]', '!repo[owner/name]',
 * '!image[ref|caption]' and '!gallery[…]' blocks in the body hydrate into
 * page cards, GitHub widgets and pictures afterwards (async for the two
 * that fetch, never blocking the open). A page that declares a `repo`
 * also wears the widget under its title block.
 *
 * PICTURES — a page that declares an `image` opens with it as a HERO:
 * the same browser-chrome frame the projects showcase wears
 * (engine/shotFrame.ts), full column width. A page that declares a
 * `gallery` closes with the thumbnail grid (engine/gallery.ts). Hero and
 * gallery share ONE album, hero first, so the lightbox pages through
 * everything this page shows — '2 / 11' means what it says.
 *
 * ROOM TO ROOM — a card or link inside a page points at another
 * '#/page/:slug', so the room swaps INSTEAD of closing:
 *   - the anchor's hash change is a real history entry (pushState
 *     semantics), so browser Back walks the chain back to the referencing
 *     page and, at the bottom of it, out to the site;
 *   - the scroll lock is taken ONCE, at the first open, and handed over
 *     across swaps — the ref-counted overlayLock never double-locks;
 *   - focus follows: into the room on open, onto the card/link that led
 *     here when Back returns along the chain, back to the original
 *     trigger when the room finally closes;
 *   - Escape still exits to the site, from any depth.
 */
import './styles/pageRoom.css';
import { gsap } from 'gsap';
import { fetchPage, type PageView } from './engine/data';
import {
  closeLightbox,
  createFramedShot,
  createGalleryGrid,
  hydrateGalleryBlocks,
  isLightboxOpen,
  resolveShots,
  type Shot,
} from './engine/gallery';
import { renderMarkdown } from './engine/markdown';
import { hydratePageBlocks, pageHref } from './engine/pageCard';
import { hydrateRepoBlocks, mountRepoCard } from './engine/repoCard';
import { accentOf, applyTokens } from './engine/themes';
import { lockScroll, unlockScroll } from './engine/overlayLock';

const ROUTE_RE = /^#\/page\/([^/]+)$/;
const THEME_ID = 'seafoam-studio';

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

export interface PageRoomHandle {
  destroy(): void;
}

export function initPageRoom(reduced: () => boolean): PageRoomHandle {
  const room = el('div', 'pg-room');
  room.hidden = true;
  room.setAttribute('role', 'dialog');
  room.setAttribute('aria-modal', 'true');
  room.tabIndex = -1;
  applyTokens(room, THEME_ID, accentOf(THEME_ID, null));

  const scroller = el('div', 'pg-scroll');
  const page = el('article', 'pg-page');

  const head = el('header', 'pg-head');
  head.appendChild(el('p', 'pg-kicker', 'page'));
  const title = el('h2', 'pg-title');
  title.id = 'pg-title';
  room.setAttribute('aria-labelledby', title.id);
  head.appendChild(title);
  page.appendChild(head);

  /* the hero: the page's own image, framed, straight under the masthead */
  const heroWrap = el('div', 'pg-hero');
  heroWrap.hidden = true;
  page.appendChild(heroWrap);

  /* a page that names a repository shows it right under the title block */
  const repoWrap = el('div', 'pg-repo');
  repoWrap.hidden = true;
  page.appendChild(repoWrap);

  const body = el('div', 'pg-body');
  page.appendChild(body);

  /* the gallery closes the page — a quiet kicker over the grid */
  const galleryWrap = el('section', 'pg-gallery');
  galleryWrap.hidden = true;
  galleryWrap.setAttribute('aria-label', 'Screens');
  const galleryKicker = el('p', 'pg-gal-kicker', 'screens');
  galleryWrap.appendChild(galleryKicker);
  page.appendChild(galleryWrap);

  scroller.appendChild(page);
  room.appendChild(scroller);

  const closeBtn = el('button', 'pg-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close page — back to the site');
  closeBtn.addEventListener('click', () => {
    location.hash = '';
  });
  room.appendChild(closeBtn);

  document.body.appendChild(room);

  /* ----------------------------------------------------------- states --- */

  /** Empty every slot that is not the body — each non-page state clears
      the widget AND the pictures, so nothing survives a swap. */
  function clearFurniture(): void {
    repoWrap.textContent = '';
    repoWrap.hidden = true;
    heroWrap.textContent = '';
    heroWrap.hidden = true;
    while (galleryKicker.nextSibling) galleryKicker.nextSibling.remove();
    galleryWrap.hidden = true;
  }

  function setStatus(titleText: string, statusText: string): void {
    title.textContent = titleText;
    clearFurniture();
    body.textContent = '';
    body.appendChild(el('p', 'pg-status', statusText));
  }

  function renderPage(p: PageView): void {
    title.textContent = p.title;
    clearFurniture();

    /* ONE album for the page: the hero leads it, the gallery follows, so
       the lightbox's counter covers everything the page shows */
    const hero: Shot[] = resolveShots(p.image ? [{ ref: p.image }] : []);
    const strip: Shot[] = resolveShots(p.gallery);
    const album: Shot[] = [...hero, ...strip];
    if (hero.length > 0) {
      heroWrap.hidden = false;
      heroWrap.appendChild(createFramedShot(hero[0], album, 0));
    }

    const repo = p.repo?.trim() ?? '';
    if (repo) {
      repoWrap.hidden = false;
      repoWrap.appendChild(mountRepoCard(repo));
    }

    body.textContent = '';
    body.appendChild(renderMarkdown(p.body ?? ''));

    const grid = createGalleryGrid(strip, { album, offset: hero.length });
    if (grid !== null) {
      galleryWrap.hidden = false;
      galleryWrap.appendChild(grid);
    }
  }

  /* ------------------------------------------------------- open/close --- */

  let openSlug: string | null = null;
  let loadSeq = 0;
  let returnFocusTo: HTMLElement | null = null;
  let savedScrollY = 0;
  let lockedView: HTMLElement | null = null;
  /** The room's own hash history — deepest last; drives the focus chain. */
  let chain: string[] = [];
  /** Set when Back walked us up the chain: the slug we just came FROM. */
  let backFrom: string | null = null;
  /** A swap (not a first open) is waiting for its content to land. */
  let swapping = false;

  /**
   * Record a navigation and report whether it was a walk BACK. Going back
   * to the entry below the top pops the chain and names the page we left,
   * so focus can return to the very card/link that led out of here.
   */
  function noteNav(slug: string): string | null {
    const depth = chain.length;
    if (depth >= 2 && chain[depth - 2] === slug) {
      const cameFrom = chain[depth - 1];
      chain.pop();
      return cameFrom;
    }
    chain.push(slug);
    return null;
  }

  /** Focus the link that points at `slug`, if this page still shows one. */
  function focusLinkTo(slug: string): boolean {
    const want = pageHref(slug);
    for (const a of body.querySelectorAll('a')) {
      if (a.getAttribute('href') === want) {
        a.focus();
        return a === document.activeElement;
      }
    }
    return false;
  }

  /** After a swap: focus the referring link when returning, else the room. */
  function placeFocusAfterSwap(): void {
    if (!swapping) return;
    swapping = false;
    if (backFrom !== null && focusLinkTo(backFrom)) {
      backFrom = null;
      return;
    }
    room.focus();
  }

  /** The article re-settles on a swap — same beat as the first open. */
  function flashIn(): void {
    if (reduced()) return;
    gsap.killTweensOf(page);
    gsap.fromTo(
      page,
      { y: 12, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.35, ease: 'power2.out', clearProps: 'opacity,transform' },
    );
  }

  function loadPage(slug: string): void {
    const seq = ++loadSeq;
    const swap = swapping;
    setStatus('Loading…', 'fetching the page…');
    void fetchPage(slug)
      .then((p) => {
        if (seq !== loadSeq || openSlug !== slug) return;
        if (p === null) {
          setStatus('Page not found', 'nothing published at this address — esc or close returns to the site');
          placeFocusAfterSwap();
          return;
        }
        renderPage(p);
        /* pictures resolve from the bundle — synchronous, no slot ever
           lingers empty (the two hydrators below DO fetch) */
        hydrateGalleryBlocks(body);
        if (swap) flashIn();
        /* the page is readable NOW; embedded page cards and repo widgets
           fill in behind it — the two hydrators share one grid */
        const pending = Promise.all([hydratePageBlocks(body), hydrateRepoBlocks(body)]);
        placeFocusAfterSwap();
        void pending.then(() => {
          if (seq !== loadSeq) return;
          /* a card we arrived through may have been one of those blocks —
             claim it only if focus is still parked on the room itself */
          if (backFrom !== null && document.activeElement === room) {
            if (focusLinkTo(backFrom)) backFrom = null;
          }
        });
      })
      .catch(() => {
        if (seq !== loadSeq || openSlug !== slug) return;
        setStatus('Page unavailable', 'could not load this page — esc or close returns to the site');
        placeFocusAfterSwap();
      });
  }

  function openRoom(slug: string): void {
    if (openSlug === slug) return;
    const firstOpen = openSlug == null;
    openSlug = slug;
    backFrom = noteNav(slug);
    if (firstOpen) {
      const active = document.activeElement;
      returnFocusTo = active instanceof HTMLElement && active !== document.body ? active : null;
      savedScrollY = window.scrollY;
      lockedView = document.querySelector<HTMLElement>('.vw.is-active');
      lockScroll(lockedView); /* deck track + the active view, ref-counted */
      room.hidden = false;
      if (!reduced()) {
        /* OPACITY, not autoAlpha: gsap renders a fromTo's start state
           SYNCHRONOUSLY, and autoAlpha's zero end writes
           visibility:hidden — an element the browser refuses to focus, so
           the room.focus() below would silently no-op and the trigger
           card would keep the ring. '[hidden]' already does the hiding
           (display:none in the stylesheet); the fade only needs alpha. */
        gsap.fromTo(
          room,
          { opacity: 0 },
          { opacity: 1, duration: 0.3, ease: 'power1.out', clearProps: 'opacity,visibility' },
        );
        gsap.fromTo(
          page,
          { y: 18, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.45, ease: 'power2.out', clearProps: 'opacity,transform' },
        );
      }
      room.focus();
    } else {
      /* room → room: the overlay stays mounted and the lock stays taken
         (one lock, handed over — never a second one), only the content
         and the focus move */
      swapping = true;
    }
    scroller.scrollTop = 0;
    loadPage(slug);
  }

  function closeRoom(): void {
    if (openSlug == null) return;
    /* a lightbox opened from this room goes first: it releases its own
       (ref-counted) lock before the room releases the room's */
    closeLightbox();
    openSlug = null;
    loadSeq += 1; /* drop in-flight fetches */
    chain = [];
    backFrom = null;
    swapping = false;
    gsap.killTweensOf([room, page]);
    gsap.set([room, page], { clearProps: 'opacity,visibility,transform' });
    room.hidden = true;
    unlockScroll(lockedView);
    lockedView = null;
    /* leaving via '#' the browser jumps to top — put the deck back */
    window.scrollTo(0, savedScrollY);
    const target = returnFocusTo;
    returnFocusTo = null;
    if (target && target.isConnected) target.focus();
  }

  function route(): void {
    const m = ROUTE_RE.exec(location.hash);
    if (m) openRoom(decodeURIComponent(m[1]));
    else closeRoom();
  }

  /* --------------------------------------------------------- wiring --- */

  const onHashChange = (): void => route();
  window.addEventListener('hashchange', onHashChange);

  /* capture phase, like the other rooms: the deck's global Escape sees
     defaultPrevented and stands down */
  const onDocKeydown = (e: KeyboardEvent): void => {
    /* the lightbox is the topmost room while it is up: Escape closes THAT
       and the page stays open (both listen in capture, so the check is a
       predicate, never a race on listener order) */
    if (e.key === 'Escape' && openSlug != null && !isLightboxOpen()) {
      e.preventDefault();
      location.hash = '';
    }
  };
  document.addEventListener('keydown', onDocKeydown, true);

  /* deep link on initial page load — deferred a microtask so the deck can
     seat the scrollbar first (same idiom as the other rooms) */
  queueMicrotask(route);

  return {
    destroy(): void {
      window.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('keydown', onDocKeydown, true);
      closeRoom();
      room.remove();
    },
  };
}

export default initPageRoom;
