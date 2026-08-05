/**
 * BLOG — the LIVE section. Wears the Sunburst editorial treatment
 * (shell/entry/bloom imported from editorial.ts) but the entries come
 * from fetchPosts() — the event-sourced API.
 *
 * States: loading (quiet skeleton lines), loaded (posts newest first:
 * date in the margin, linked title, deck, tags), error (falls back to
 * the section's content.json items under a one-line 'showing drafts —
 * API offline' note).
 *
 * READING VIEW: a hash router (#/blog/:slug) opens a full-overlay
 * reading room in the Sunburst finish — kicker BLOG, date, display-serif
 * title, deck as standfirst, the body through the strict-subset markdown
 * engine (DOM built via textContent only — no HTML injection), tags, a
 * close control. The room lives on
 * document.body (with the Sunburst tokens applied to it directly) so it
 * survives the deck's display model; while open it locks BOTH the body
 * (the deck track) and the blog view's inner scroller. Escape and the
 * close control both return to #; focus moves into the overlay on open
 * and back to the triggering link on close; deep links work on initial
 * page load (deferred a microtask so the deck can seat the scrollbar
 * on the blog slot first).
 *
 * Entrance (deck lifecycle): burst bloom + lede/entries rise like
 * editorial; entries that land after the fetch rise on their own when
 * the view is already on stage.
 */
import '../styles/blog.css';
import { gsap } from 'gsap';
import { fetchPost, fetchPosts, inlineItems, type PostView } from '../engine/data';
import { closeLightbox, hydrateGalleryBlocks, isLightboxOpen } from '../engine/gallery';
import { renderMarkdown } from '../engine/markdown';
import { lockScroll, unlockScroll } from '../engine/overlayLock';
import {
  addBurstBloom,
  buildEditorialEntry,
  buildEditorialShell,
  prepareBurstBloom,
  settleBurstBloom,
} from './editorial';
import type { SectionBuilder } from './types';

const ROUTE_RE = /^#\/blog\/([^/]+)$/;

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

function postStamp(p: PostView): string {
  return p.publishedAt ?? p.updatedAt;
}

export const buildBlog: SectionBuilder = (host, section, _index, ctx) => {
  /* page blocks are a showcase/markdown feature — this band reads the
     inline items and is untouched by the item union */
  const copyItems = inlineItems(section);
  const shell = buildEditorialShell(section, ctx, 'vw-blog is-offstage');
  host.appendChild(shell.wrap);

  /* ------------------------------------------------- loading skeleton --- */

  const skeletonRows: HTMLElement[] = [];
  for (let i = 0; i < Math.max(3, copyItems.length); i++) {
    const row = el('div', 'bl-skel-entry');
    row.setAttribute('aria-hidden', 'true');
    row.appendChild(el('span', 'bl-skel-bar bl-skel-bar--margin'));
    const main = el('div', 'bl-skel-main');
    main.appendChild(el('span', 'bl-skel-bar bl-skel-bar--title'));
    main.appendChild(el('span', 'bl-skel-bar bl-skel-bar--deck'));
    main.appendChild(el('span', 'bl-skel-bar bl-skel-bar--deck2'));
    row.appendChild(main);
    shell.entries.appendChild(row);
    skeletonRows.push(row);
  }
  const loadingSr = el('p', 'mx-sr', 'Loading posts…');
  shell.entries.appendChild(loadingSr);

  /* --------------------------------------------- entrance bookkeeping ---
     Posts land async. If they arrive while the view is on stage with its
     entrance already played, they rise on their own; otherwise they sit
     in the DOM and the next prepare/play cycle choreographs them. */

  let onStage = false;
  let entrancePlayed = false;

  function queueEntryReveal(items: HTMLElement[]): void {
    if (!items.length) return;
    if (onStage && entrancePlayed && !ctx.reduced()) {
      gsap.fromTo(
        items,
        { opacity: 0, y: 24 },
        { opacity: 1, y: 0, duration: 0.6, stagger: 0.07, ease: 'power2.out', clearProps: 'opacity,transform' },
      );
    }
  }

  /* -------------------------------------------------- entries states --- */

  function clearEntries(): void {
    shell.entries.textContent = '';
  }

  function renderEntries(
    specs: { title: string; deck: string; date?: string; tags?: string[]; href?: string }[],
    note?: string,
  ): void {
    clearEntries();
    if (note) shell.bodyCol.insertBefore(el('p', 'bl-note', note), shell.entries);
    const items: HTMLElement[] = [];
    for (const spec of specs) {
      const entry = buildEditorialEntry(spec);
      shell.entries.appendChild(entry.root);
      items.push(entry.root);
    }
    queueEntryReveal(items);
  }

  function renderPosts(posts: PostView[]): void {
    const sorted = [...posts].sort((a, b) => postStamp(b).localeCompare(postStamp(a)));
    renderEntries(
      sorted.map((p) => ({
        title: p.title,
        deck: p.deck,
        date: postStamp(p).slice(0, 10),
        tags: p.tags,
        href: '#/blog/' + encodeURIComponent(p.slug),
      })),
    );
  }

  function renderDrafts(note: string): void {
    renderEntries(
      copyItems.map((it) => ({ title: it.title, deck: it.deck, date: it.date, tags: it.tags })),
      note,
    );
  }

  void fetchPosts()
    .then((posts) => {
      if (posts.length) renderPosts(posts);
      else renderDrafts('no posts published yet — showing drafts');
    })
    .catch(() => {
      renderDrafts('showing drafts — API offline');
    });

  /* ------------------------------------------------ reading room DOM --- */

  const room = el('div', 'bl-room');
  room.hidden = true;
  room.setAttribute('role', 'dialog');
  room.setAttribute('aria-modal', 'true');
  room.tabIndex = -1;

  const scroller = el('div', 'bl-room-scroll');
  const post = el('article', 'bl-post');

  const postBand = el('div', 'ed-band bl-post-band');
  const postDisc = el('div', 'ed-disc');
  postDisc.setAttribute('aria-hidden', 'true');
  postBand.appendChild(postDisc);
  const postBandInner = el('div', 'ed-band-inner mx-col');
  postBandInner.appendChild(el('p', 'bl-post-kicker', 'Blog'));
  const postDate = el('p', 'bl-post-date');
  postBandInner.appendChild(postDate);
  const postTitle = el('h2', 'ed-headline bl-post-title');
  postTitle.id = 'bl-post-title-' + section.id;
  room.setAttribute('aria-labelledby', postTitle.id);
  postBandInner.appendChild(postTitle);
  postBand.appendChild(postBandInner);
  post.appendChild(postBand);

  const postBody = el('div', 'ed-body');
  const postCol = el('div', 'mx-col bl-post-colwrap');
  const standfirst = el('p', 'bl-standfirst');
  const paras = el('div', 'bl-post-body');
  const postTags = el('p', 'bl-post-tags');
  postCol.appendChild(standfirst);
  postCol.appendChild(paras);
  postCol.appendChild(postTags);
  postBody.appendChild(postCol);
  post.appendChild(postBody);

  scroller.appendChild(post);
  room.appendChild(scroller);

  const closeBtn = el('button', 'bl-room-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close post — back to the blog');
  closeBtn.addEventListener('click', () => {
    location.hash = '';
  });
  room.appendChild(closeBtn);

  /* the room lives on <body>: the deck hides inactive views with
     display:none, which would swallow a fixed overlay nested inside.
     It carries its own copy of the Sunburst tokens. */
  ctx.applyTokens(room, ctx.mix.theme, ctx.accentOf(ctx.mix.theme, section.id));
  document.body.appendChild(room);

  /* ------------------------------------------------ reading room logic --- */

  let openSlug: string | null = null;
  let loadSeq = 0;
  let returnFocusTo: HTMLElement | null = null;
  let savedScrollY = 0;

  function setRoomLoading(): void {
    postDate.textContent = '';
    postTitle.textContent = 'Loading…';
    standfirst.textContent = '';
    paras.textContent = '';
    postTags.textContent = '';
    paras.appendChild(el('p', 'bl-room-status', 'replaying post events…'));
  }

  function setRoomError(): void {
    postDate.textContent = '';
    postTitle.textContent = 'Post unavailable';
    standfirst.textContent = '';
    paras.textContent = '';
    postTags.textContent = '';
    paras.appendChild(
      el('p', 'bl-room-status', 'could not load this post — esc or close returns to the blog'),
    );
  }

  function renderPost(p: PostView): void {
    postDate.textContent = postStamp(p).slice(0, 10);
    postTitle.textContent = p.title;
    standfirst.textContent = p.deck;
    paras.textContent = '';
    /* the strict-subset markdown engine: DOM built via createElement /
       textContent only — literal HTML in a body stays literal text */
    paras.appendChild(renderMarkdown(p.body ?? ''));
    /* '!image[…]' / '!gallery[…]' blocks resolve from the bundle — local
       and synchronous, so no slot ever lingers empty */
    hydrateGalleryBlocks(paras);
    postTags.textContent = '';
    for (const t of p.tags) postTags.appendChild(el('span', null, t));
  }

  function loadPost(slug: string): void {
    const seq = ++loadSeq;
    setRoomLoading();
    void fetchPost(slug)
      .then((p) => {
        if (seq !== loadSeq || openSlug !== slug) return;
        renderPost(p);
      })
      .catch(() => {
        if (seq !== loadSeq || openSlug !== slug) return;
        setRoomError();
      });
  }

  function openRoom(slug: string): void {
    if (openSlug === slug) return;
    const firstOpen = openSlug == null;
    openSlug = slug;
    if (firstOpen) {
      const active = document.activeElement;
      returnFocusTo = active instanceof HTMLElement && active !== document.body ? active : null;
      savedScrollY = window.scrollY;
      lockScroll(shell.wrap); /* deck track + the inner scroller, ref-counted */
      room.hidden = false;
      if (!ctx.reduced()) {
        /* OPACITY, not autoAlpha — see pageRoom.ts: gsap renders a fromTo's
           start state synchronously, and autoAlpha's zero writes
           visibility:hidden, which the browser refuses to focus, so the
           room.focus() below would no-op. '[hidden]' does the hiding. */
        gsap.fromTo(
          room,
          { opacity: 0 },
          { opacity: 1, duration: 0.3, ease: 'power1.out', clearProps: 'opacity,visibility' },
        );
        gsap.fromTo(
          post,
          { y: 18, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.45, ease: 'power2.out', clearProps: 'opacity,transform' },
        );
      }
      room.focus();
    }
    scroller.scrollTop = 0;
    loadPost(slug);
  }

  function closeRoom(): void {
    if (openSlug == null) return;
    /* a lightbox opened from this post goes first: it releases its own
       (ref-counted) lock before the room releases the room's */
    closeLightbox();
    openSlug = null;
    loadSeq += 1; /* drop in-flight fetches */
    gsap.killTweensOf([room, post]);
    gsap.set([room, post], { clearProps: 'opacity,visibility,transform' });
    room.hidden = true;
    unlockScroll(shell.wrap);
    /* leaving via '#' the browser jumps to top — put the reader back */
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

  const onHashChange = (): void => route();
  window.addEventListener('hashchange', onHashChange);

  /* Escape returns to # — capture phase so the shell's global Escape
     (scroll to overview) sees defaultPrevented and stands down. */
  const onDocKeydown = (e: KeyboardEvent): void => {
    /* a lightbox is the topmost room while it is up: Escape closes THAT
       and the post stays open */
    if (e.key === 'Escape' && openSlug != null && !isLightboxOpen()) {
      e.preventDefault();
      location.hash = '';
    }
  };
  document.addEventListener('keydown', onDocKeydown, true);

  /* deep link works on initial page load — deferred a microtask so the
     deck (initialized right after the views are built) seats the
     scrollbar on the blog slot BEFORE the room saves the scroll position
     and locks the track */
  queueMicrotask(route);

  /* ------------------------------------------------------------- view --- */

  /** Everything that rises with the entrance, queried live (async posts
      replace the entries; a note may sit between lede and entries). */
  function riseItems(): HTMLElement[] {
    const items: HTMLElement[] = [shell.lede];
    for (const node of shell.bodyCol.querySelectorAll<HTMLElement>('.bl-note')) items.push(node);
    for (const node of Array.from(shell.entries.children)) {
      if (node instanceof HTMLElement) items.push(node);
    }
    return items;
  }

  let entranceTl: gsap.core.Timeline | null = null;

  function killEntrance(): void {
    if (entranceTl) {
      entranceTl.kill();
      entranceTl = null;
    }
    gsap.killTweensOf(riseItems());
  }

  function showInstant(): void {
    killEntrance();
    settleBurstBloom(shell);
    gsap.set(riseItems(), { clearProps: 'opacity,visibility,transform' });
  }

  const mqBlog = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onMotionChange = (): void => {
    if (ctx.reduced()) showInstant();
  };
  if (typeof mqBlog.addEventListener === 'function') {
    mqBlog.addEventListener('change', onMotionChange);
  }

  return {
    el: shell.wrap,
    headline: shell.headline,
    prepareEntrance() {
      entrancePlayed = false;
      if (ctx.reduced()) return;
      killEntrance();
      prepareBurstBloom(shell);
      gsap.set(riseItems(), { opacity: 0, y: 24 });
    },
    playEntrance() {
      killEntrance();
      if (ctx.reduced()) {
        entrancePlayed = true;
        showInstant();
        return;
      }
      entranceTl = gsap.timeline({
        onComplete() {
          entrancePlayed = true;
        },
      });
      addBurstBloom(ctx, shell, entranceTl);
      entranceTl.to(
        riseItems(),
        { opacity: 1, y: 0, duration: 0.6, stagger: 0.07, ease: 'power2.out', clearProps: 'opacity,transform' },
        0.15,
      );
    },
    onEnter() {
      onStage = true;
      shell.wrap.classList.remove('is-offstage'); /* skeleton pulse on stage only */
    },
    onLeave() {
      onStage = false;
      shell.wrap.classList.add('is-offstage');
    },
    destroy() {
      window.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('keydown', onDocKeydown, true);
      if (typeof mqBlog.removeEventListener === 'function') {
        mqBlog.removeEventListener('change', onMotionChange);
      }
      closeRoom();
      room.remove();
      killEntrance();
      settleBurstBloom(shell);
      gsap.killTweensOf(skeletonRows);
    },
  };
};

export default buildBlog;
