/**
 * MAINTAIN — the #/maintain maintainer console: a body-level overlay in
 * the Event Log finish (mono, offsets, Lake Placid accents — the console
 * IS a dev tool) where Diego manages posts AND pages from the site
 * itself.
 *
 * Overlay mechanics mirror the blog reading room: the room lives on
 * document.body (the deck hides inactive views with display:none), wears
 * its own copy of the Event Log tokens via applyTokens, and while open
 * locks BOTH the body (the deck track) and the active view's inner
 * scroller. Escape and the close control return to '#'; focus moves into
 * the overlay on open and back to the trigger on close. The hash router
 * coexists with '#/blog/…', '#/page/…' and the section hashes —
 * '#/maintain' is the only route it owns.
 *
 * TOKEN GATE: without a token in sessionStorage ('eleva-admin-token') a
 * centered gate asks for one and validates it with GET /api/admin/posts
 * (401 → inline error, stay; 503 → 'admin disabled on this server').
 * The token lives ONLY in sessionStorage and travels ONLY as the
 * x-admin-token header — never in URLs or logs. 'log out' clears it.
 *
 * TABS: Posts | Pages — a real tablist (role=tab, aria-selected, arrow
 * keys). Both tabs are the SAME spec-driven panel: left a table (status
 * chip, title, updatedAt desc, 'new …' on top); right an editor with
 * Save (POST draft:true for new, PATCH of only the changed fields), a
 * per-status Publish/Unpublish toggle — no optimism, every mutation
 * re-fetches — and below it the slug's raw EVENT HISTORY as a log stream
 * (pad4 offset, type, timestamp, compact data summary). Posts edit
 * title/deck/tags/body; pages edit title/summary/image/gallery/repo/body —
 * summary is the card copy (live count against its 300-char limit), image
 * is the card picture ('https://…' or 'asset:<token>'), gallery is the
 * page's picture strip (ONE PER LINE, 'ref|caption', parsed to the array
 * the API stores and rendered back one-per-line on load) and repo is the
 * GitHub widget's 'owner/name', all validated here before the API has to
 * say 400 — including the one check only this build can make: an
 * 'asset:<token>' the running bundle does not carry is named and refused,
 * because it would render as nothing at all. Every change is summarized in
 * the event history like any other (an empty value, and an empty gallery,
 * read '(cleared)', because that is what they do).
 * Markdown textareas carry a live preview toggle that renders through the
 * EXACT engine the site uses (src/engine/markdown.ts — dogfooding, page
 * cards and repo widgets included). ALL api data lands via
 * textContent. A dirty editor asks confirm() once before Escape/close
 * (or a row switch / log out) discards it; a hidden tab keeps its editor
 * state, so switching tabs never discards anything.
 */
import './styles/maintain.css';
import { gsap } from 'gsap';
import { accentOf, applyTokens } from './engine/themes';
import {
  ApiError,
  adminCreatePage,
  adminCreatePost,
  adminFetchEvents,
  adminFetchPage,
  adminFetchPageEvents,
  adminFetchPages,
  adminFetchPost,
  adminFetchPosts,
  adminPublishPage,
  adminPublishPost,
  adminRevisePage,
  adminRevisePost,
  adminUnpublishPage,
  adminUnpublishPost,
  type PageChanges,
  type PostChanges,
  type StoreEventView,
} from './engine/adminApi';
import { isRepoRef, type PageView, type PostView } from './engine/data';
import { ASSET_TOKENS, isImageRef, isUnknownAssetRef } from './engine/assets';
import {
  GALLERY_MAX_ENTRIES,
  closeLightbox,
  formatGalleryLines,
  hydrateGalleryBlocks,
  isLightboxOpen,
  parseGalleryLines,
} from './engine/gallery';
import { renderMarkdown } from './engine/markdown';
import { hydratePageBlocks } from './engine/pageCard';
import { hydrateRepoBlocks } from './engine/repoCard';
import { lockScroll, unlockScroll } from './engine/overlayLock';

const ROUTE = '#/maintain';
const TOKEN_KEY = 'eleva-admin-token';
const THEME_ID = 'event-log';
const MD_HINT = 'markdown, strict subset — # headings, **bold**, *italic*, `code`, ``` fences, lists, > quotes, https/mailto/# links, !page[slug] cards, !repo[owner/name] widgets, !image[ref|caption] figures, !gallery[ref, ref] grids';
/** The page card contract, mirrored from the API's validator (the repo
    format is not mirrored twice — isRepoRef() is the same gate the widget
    client already applies before it will request anything; the image
    format likewise, through the asset registry's isImageRef()). */
const PAGE_SUMMARY_MAX = 300;

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

function pad4(seq: number): string {
  return String(seq).padStart(4, '0');
}

/** '2026-08-05T09:41:07.123Z' → '2026-08-05 09:41:07' (defensive slice). */
function fmtAt(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

function parseTags(s: string): string[] {
  return s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/* Compact one-line summary of an event payload — rendered via textContent
   only, so whatever the API sends stays inert text. */
function summarizePart(k: string, v: unknown): string {
  if (typeof v === 'string') {
    if (k === 'body') return `body(${v.length} chars)`;
    /* '' is the CLEAR gesture for summary/image/repo — say so, don't
       print an empty pair of quotes and make the reader infer it */
    if (v === '') return k + '=(cleared)';
    return k + '="' + (v.length > 42 ? v.slice(0, 41) + '…' : v) + '"';
  }
  if (Array.isArray(v)) {
    /* [] clears a list field the way '' clears a text one */
    if (v.length === 0) return k + '=(cleared)';
    /* a gallery is a list of objects — print what it points AT, in order,
       never '[object Object]' */
    return (
      k +
      '=[' +
      v
        .map((x) => {
          if (x !== null && typeof x === 'object' && 'ref' in x) {
            return String((x as { ref: unknown }).ref);
          }
          return String(x);
        })
        .join(', ') +
      ']'
    );
  }
  if (v === null || v === undefined) return k + '=null';
  if (typeof v === 'object') return k + '={…}';
  return k + '=' + String(v);
}

function summarize(data: Record<string, unknown>): string {
  if (data === null || typeof data !== 'object') return String(data ?? '—');
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === 'changes' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        parts.push(summarizePart(ck, cv));
      }
      continue;
    }
    parts.push(summarizePart(k, v));
  }
  return parts.length ? parts.join(' · ') : '—';
}

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(t: string | null): void {
  try {
    if (t === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* privacy mode — the token just won't survive within the tab */
  }
}

function describe(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'token rejected (401) — log out and reconnect';
    if (e.status === 503) return 'admin disabled on this server (503)';
    return `${fallback} (${e.status}: ${e.message})`;
  }
  return fallback + ' — API unreachable';
}

/* ===================================================== panel factory ===
   Posts and Pages are the SAME console pattern over different fields and
   endpoints. One spec-driven factory keeps their behavior identical —
   dirty-guard, error strip, no-optimism re-fetching, event history. */

type ContentStatus = 'draft' | 'published' | 'unpublished';

interface ContentView {
  slug: string;
  title: string;
  status: ContentStatus;
  updatedAt: string;
}

interface FieldSpec {
  key: string;
  label: string;
  kind: 'input' | 'area';
  rows?: number;
  hint?: string;
  placeholder?: string;
  /** Max length — draws a live 'n/max' count beside the label. */
  count?: number;
  /** areas only: a live preview toggle through the markdown engine. */
  preview?: boolean;
}

interface PanelSpec<TView extends ContentView, TChanges extends object> {
  id: string;
  /** Tab label — also the table's aria-label ('Posts'). */
  label: string;
  noun: string;
  fields: FieldSpec[];
  emptyText: string;
  duplicateMsg: string;
  toBase(v: TView): Record<string, string>;
  /** Normalized diff of editor vs base; null → nothing changed. */
  diff(base: Record<string, string>, f: Record<string, string>): TChanges | null;
  /** Error message for an invalid new draft, or null when fine. */
  validateNew(f: Record<string, string>): string | null;
  /**
   * Field-shape check run before EVERY write (new and revise) — the same
   * rules the API enforces, said early so a 400 never has to teach them.
   */
  validate?(f: Record<string, string>): string | null;
  create(token: string, f: Record<string, string>): Promise<TView>;
  fetchAll(token: string): Promise<TView[]>;
  fetchOne(token: string, slug: string): Promise<TView>;
  fetchEvents(token: string, slug: string): Promise<StoreEventView[]>;
  revise(token: string, slug: string, changes: TChanges): Promise<TView>;
  publish(token: string, slug: string): Promise<TView>;
  unpublish(token: string, slug: string): Promise<TView>;
}

interface PanelHandle {
  root: HTMLElement;
  /** Re-fetch the table. Throws so the caller can route auth failures. */
  refresh(token: string): Promise<void>;
  clearEditor(): void;
  clearAll(): void;
  isDirty(): boolean;
  isBusy(): boolean;
  /** Invalidate in-flight loads (room closing). */
  bumpSeq(): void;
  setError(msg: string | null): void;
}

interface PanelDeps {
  getToken(): string | null;
  onBusyChange(): void;
}

function makePanel<TView extends ContentView, TChanges extends object>(
  spec: PanelSpec<TView, TChanges>,
  deps: PanelDeps,
): PanelHandle {
  const root = el('div', 'mt-panel');
  root.id = 'mt-panel-' + spec.id;
  root.setAttribute('role', 'tabpanel');
  root.setAttribute('aria-labelledby', 'mt-tab-' + spec.id);
  root.hidden = true;
  const cols = el('div', 'mt-cols');
  root.appendChild(cols);

  /* left — the table */
  const listSec = el('section', 'mt-list');
  listSec.setAttribute('aria-label', spec.label);
  const listHead = el('div', 'mt-list-head');
  const newBtn = el('button', 'mt-btn', 'new ' + spec.noun);
  newBtn.type = 'button';
  listHead.appendChild(newBtn);
  const countEl = el('span', 'mt-count');
  listHead.appendChild(countEl);
  listSec.appendChild(listHead);
  const tableWrap = el('div', 'mt-table-wrap');
  const table = el('table', 'mt-table');
  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['status', 'title', 'updated']) hrow.appendChild(el('th', null, h));
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el('tbody');
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  listSec.appendChild(tableWrap);
  const listEmpty = el('p', 'mt-empty', spec.emptyText);
  listEmpty.hidden = true;
  listSec.appendChild(listEmpty);
  cols.appendChild(listSec);

  /* right — the editor + event history */
  const edSec = el('section', 'mt-editor');
  edSec.setAttribute('aria-label', spec.noun.charAt(0).toUpperCase() + spec.noun.slice(1) + ' editor');
  const errEl = el('p', 'mt-err');
  errEl.setAttribute('role', 'alert');
  errEl.hidden = true;
  edSec.appendChild(errEl);
  const hint = el('p', 'mt-hint', 'select a ' + spec.noun + ' on the left — or start a new one');
  edSec.appendChild(hint);

  const form = el('form', 'mt-form');
  form.hidden = true;

  const statusLine = el('div', 'mt-slugline');
  const statusChip = el('span', 'mt-chip');
  const slugEl = el('span', 'mt-slug');
  const updEl = el('span', 'mt-updline');
  statusLine.appendChild(statusChip);
  statusLine.appendChild(slugEl);
  statusLine.appendChild(updEl);
  form.appendChild(statusLine);

  const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const previewResets: (() => void)[] = [];
  /** Re-read every field's derived chrome (the live counts) after a fill. */
  const fieldSyncs: (() => void)[] = [];

  for (const fs of spec.fields) {
    const wrap = el('div', 'mt-field');
    const id = 'mt-' + spec.id + '-f-' + fs.key;
    const lb = el('label', 'mt-label', fs.label);
    lb.htmlFor = id;
    let control: HTMLInputElement | HTMLTextAreaElement;
    if (fs.kind === 'area') {
      const area = el('textarea', 'mt-area');
      area.rows = fs.rows ?? 12;
      control = area;
    } else {
      const input = el('input', 'mt-input');
      input.type = 'text';
      input.autocomplete = 'off';
      control = input;
    }
    control.id = id;
    if (fs.placeholder) control.placeholder = fs.placeholder;

    const wantsPreview = fs.preview === true && fs.kind === 'area';
    const wantsCount = typeof fs.count === 'number';

    if (wantsPreview || wantsCount) {
      /* the label row carries the field's chrome: a live character count,
         and for markdown areas the preview toggle */
      const row = el('div', 'mt-label-row');
      row.appendChild(lb);
      if (wantsCount) {
        const max = fs.count ?? 0;
        /* aria-hidden: the limit is stated once in the hint below, so the
           per-keystroke count stays a visual affordance, not chatter */
        const counter = el('span', 'mt-counter');
        counter.setAttribute('aria-hidden', 'true');
        row.appendChild(counter);
        const syncCount = (): void => {
          const n = control.value.length;
          counter.textContent = n + '/' + max;
          counter.classList.toggle('is-over', n > max);
        };
        control.addEventListener('input', syncCount);
        fieldSyncs.push(syncCount);
      }
      if (wantsPreview) {
        const pvBtn = el('button', 'mt-previewbtn', 'preview');
        pvBtn.type = 'button';
        pvBtn.setAttribute('aria-pressed', 'false');
        row.appendChild(pvBtn);
        wrap.appendChild(row);
        wrap.appendChild(control);
        const pane = el('div', 'mt-preview');
        pane.id = id + '-preview';
        pane.setAttribute('aria-label', fs.label + ' — markdown preview');
        pane.hidden = true;
        pvBtn.setAttribute('aria-controls', pane.id);
        wrap.appendChild(pane);
        let on = false;
        const sync = (): void => {
          pvBtn.setAttribute('aria-pressed', String(on));
          pvBtn.textContent = on ? 'edit' : 'preview';
          if (on) {
            pane.textContent = '';
            pane.appendChild(renderMarkdown(control.value));
            /* the preview IS the site's engine — page blocks and repo
               widgets resolve here exactly as they will in the reading
               room (both are cached per slug / per owner-name, so toggling
               the preview does not re-request anything) */
            void hydratePageBlocks(pane);
            void hydrateRepoBlocks(pane);
            hydrateGalleryBlocks(pane); /* pictures are local: no promise */
          }
          control.hidden = on;
          pane.hidden = !on;
        };
        pvBtn.addEventListener('click', () => {
          on = !on;
          sync();
          if (!on) control.focus();
        });
        previewResets.push(() => {
          if (on) {
            on = false;
            sync();
          }
        });
      } else {
        wrap.appendChild(row);
        wrap.appendChild(control);
      }
    } else {
      wrap.appendChild(lb);
      wrap.appendChild(control);
    }

    if (fs.hint) {
      const h = el('span', 'mt-field-hint', fs.hint);
      h.id = id + '-hint';
      control.setAttribute('aria-describedby', h.id);
      wrap.appendChild(h);
    }
    form.appendChild(wrap);
    controls.set(fs.key, control);
  }

  /** Push the current values into the derived chrome (counts). */
  function syncFields(): void {
    for (const s of fieldSyncs) s();
  }
  syncFields(); /* an empty editor still reads '0/300', never a blank chip */

  const actions = el('div', 'mt-actions');
  const saveBtn = el('button', 'mt-btn', 'save');
  saveBtn.type = 'submit';
  const pubBtn = el('button', 'mt-btn mt-btn--ghost', 'publish');
  pubBtn.type = 'button';
  const noteEl = el('span', 'mt-note');
  noteEl.setAttribute('role', 'status');
  actions.appendChild(saveBtn);
  actions.appendChild(pubBtn);
  actions.appendChild(noteEl);
  form.appendChild(actions);
  edSec.appendChild(form);

  const evSec = el('section', 'mt-events');
  evSec.setAttribute('aria-label', 'Event history');
  evSec.hidden = true;
  evSec.appendChild(el('h3', 'mt-ev-head', 'event history'));
  const evList = el('div', 'mt-ev-list');
  evSec.appendChild(evList);
  edSec.appendChild(evSec);
  cols.appendChild(edSec);

  /* ----------------------------------------------------------- state --- */

  let items: TView[] = [];
  let mode: 'none' | 'new' | 'edit' = 'none';
  let current: TView | null = null;
  let base: Record<string, string> = {};
  let busy = false;
  let loadSeq = 0;

  function setErr(msg: string | null): void {
    errEl.hidden = msg === null;
    errEl.textContent = msg ?? '';
  }

  function setNote(msg: string): void {
    noteEl.textContent = msg;
  }

  function setBusy(b: boolean): void {
    busy = b;
    saveBtn.disabled = b;
    pubBtn.disabled = b;
    newBtn.disabled = b;
    deps.onBusyChange();
  }

  function readFields(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, c] of controls) out[k] = c.value;
    return out;
  }

  function isDirty(): boolean {
    if (mode === 'none') return false;
    const f = readFields();
    if (mode === 'new') return spec.fields.some((fs) => (f[fs.key] ?? '').trim() !== '');
    return spec.diff(base, f) !== null;
  }

  /** True → proceed (clean, or the maintainer confirmed the discard). */
  function confirmDiscard(): boolean {
    if (!isDirty()) return true;
    return window.confirm('discard unsaved changes?');
  }

  function resetPreviews(): void {
    for (const r of previewResets) r();
  }

  function statusChipClass(status: ContentStatus): string {
    return 'mt-chip is-' + status;
  }

  function fillEditor(v: TView): void {
    hint.hidden = true;
    form.hidden = false;
    statusChip.className = statusChipClass(v.status);
    statusChip.textContent = v.status;
    slugEl.textContent = v.slug;
    updEl.textContent = 'updated ' + fmtAt(v.updatedAt).slice(0, 16);
    for (const fs of spec.fields) {
      const c = controls.get(fs.key);
      if (c) c.value = base[fs.key] ?? '';
    }
    syncFields();
    resetPreviews();
    pubBtn.hidden = false;
    pubBtn.textContent = v.status === 'published' ? 'unpublish' : 'publish';
    saveBtn.textContent = 'save changes';
    evSec.hidden = false;
  }

  function clearEditor(): void {
    mode = 'none';
    current = null;
    base = {};
    for (const c of controls.values()) c.value = '';
    syncFields();
    resetPreviews();
    form.hidden = true;
    hint.hidden = false;
    evSec.hidden = true;
    evList.textContent = '';
    setErr(null);
    setNote('');
  }

  function startNew(): void {
    if (busy) return;
    if (!confirmDiscard()) return;
    loadSeq += 1; /* drop in-flight loads */
    mode = 'new';
    current = null;
    base = {};
    hint.hidden = true;
    form.hidden = false;
    statusChip.className = statusChipClass('draft');
    statusChip.textContent = 'new draft';
    slugEl.textContent = 'slug derives from the title';
    updEl.textContent = '';
    for (const c of controls.values()) c.value = '';
    syncFields();
    resetPreviews();
    pubBtn.hidden = true;
    saveBtn.textContent = 'save draft';
    evSec.hidden = true;
    evList.textContent = '';
    setErr(null);
    setNote('');
    renderTable(); /* clear the selection highlight */
    controls.get(spec.fields[0].key)?.focus();
  }

  /* ----------------------------------------------------- rendering --- */

  function renderTable(): void {
    tbody.textContent = '';
    const sorted = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    listEmpty.hidden = sorted.length > 0;
    tableWrap.hidden = sorted.length === 0;
    countEl.textContent = sorted.length
      ? sorted.length + ' ' + (sorted.length === 1 ? spec.noun : spec.noun + 's')
      : '';
    for (const v of sorted) {
      const tr = el('tr', 'mt-row');
      if (mode === 'edit' && current !== null && current.slug === v.slug) {
        tr.classList.add('is-selected');
      }
      const tdStatus = el('td');
      tdStatus.appendChild(el('span', statusChipClass(v.status), v.status));
      tr.appendChild(tdStatus);
      const tdTitle = el('td', 'mt-cell-title');
      const rowBtn = el('button', 'mt-row-btn', v.title);
      rowBtn.type = 'button';
      tdTitle.appendChild(rowBtn);
      tr.appendChild(tdTitle);
      tr.appendChild(el('td', 'mt-upd', fmtAt(v.updatedAt).slice(0, 16)));
      tr.addEventListener('click', () => {
        void select(v.slug);
      });
      tbody.appendChild(tr);
    }
  }

  function renderEvents(evs: StoreEventView[]): void {
    evSec.hidden = false;
    evList.textContent = '';
    if (evs.length === 0) {
      evList.appendChild(el('p', 'mt-ev-none', 'no events recorded for this slug'));
      return;
    }
    for (const ev of evs) {
      const ln = el('div', 'mt-ev-ln');
      ln.appendChild(el('span', 'mt-ev-off', pad4(ev.seq)));
      ln.appendChild(el('span', 'mt-ev-type', ev.type));
      ln.appendChild(el('span', 'mt-ev-ts', fmtAt(ev.at)));
      ln.appendChild(el('span', 'mt-ev-data', summarize(ev.data)));
      evList.appendChild(ln);
    }
  }

  /* --------------------------------------------------------- flows --- */

  async function refreshList(t: string): Promise<void> {
    items = await spec.fetchAll(t);
    renderTable();
  }

  async function reloadCurrent(t: string, slug: string): Promise<void> {
    const [v, evs] = await Promise.all([spec.fetchOne(t, slug), spec.fetchEvents(t, slug)]);
    mode = 'edit';
    current = v;
    base = spec.toBase(v);
    fillEditor(v);
    renderEvents(evs);
  }

  async function select(slug: string): Promise<void> {
    if (busy) return;
    if (mode === 'edit' && current !== null && current.slug === slug) return;
    if (!confirmDiscard()) return;
    const t = deps.getToken();
    if (t === null) return;
    const seq = ++loadSeq;
    setErr(null);
    setNote('loading ' + slug + '…');
    try {
      const [v, evs] = await Promise.all([spec.fetchOne(t, slug), spec.fetchEvents(t, slug)]);
      if (seq !== loadSeq) return;
      mode = 'edit';
      current = v;
      base = spec.toBase(v);
      fillEditor(v);
      renderEvents(evs);
      renderTable(); /* selection highlight */
      setNote('');
    } catch (e) {
      if (seq !== loadSeq) return;
      setNote('');
      setErr(describe(e, 'could not load ' + slug));
    }
  }

  async function save(): Promise<void> {
    if (busy || mode === 'none') return;
    const t = deps.getToken();
    if (t === null) return;
    setErr(null);
    const f = readFields();

    const badField = spec.validate?.(f) ?? null;
    if (badField !== null) {
      setErr(badField);
      return;
    }

    if (mode === 'new') {
      const invalid = spec.validateNew(f);
      if (invalid !== null) {
        setErr(invalid);
        return;
      }
      setBusy(true);
      setNote('saving draft…');
      try {
        const created = await spec.create(t, f);
        mode = 'edit';
        current = created;
        base = spec.toBase(created);
        fillEditor(created);
        setNote('draft saved — ' + created.slug);
        await refreshList(t);
        renderEvents(await spec.fetchEvents(t, created.slug));
      } catch (e) {
        setNote('');
        if (e instanceof ApiError && e.status === 409) setErr(spec.duplicateMsg);
        else setErr(describe(e, 'could not save the draft'));
      } finally {
        setBusy(false);
      }
      return;
    }

    const cur = current;
    if (cur === null) return;
    const changes = spec.diff(base, f);
    if (changes === null) {
      setNote('nothing changed — nothing sent');
      return;
    }
    setBusy(true);
    setNote('saving…');
    try {
      await spec.revise(t, cur.slug, changes);
      setNote('saved');
      await reloadCurrent(t, cur.slug);
      await refreshList(t);
    } catch (e) {
      setNote('');
      setErr(describe(e, 'could not save the changes'));
    } finally {
      setBusy(false);
    }
  }

  async function togglePublish(): Promise<void> {
    if (busy || mode !== 'edit') return;
    const cur = current;
    const t = deps.getToken();
    if (cur === null || t === null) return;
    if (isDirty()) {
      setErr('unsaved edits — save before changing the publish state');
      return;
    }
    const publishing = cur.status !== 'published';
    setErr(null);
    setBusy(true);
    setNote(publishing ? 'publishing…' : 'unpublishing…');
    try {
      if (publishing) await spec.publish(t, cur.slug);
      else await spec.unpublish(t, cur.slug);
      setNote(publishing ? 'published' : 'unpublished');
      await reloadCurrent(t, cur.slug);
      await refreshList(t);
    } catch (e) {
      setNote('');
      setErr(describe(e, publishing ? 'could not publish' : 'could not unpublish'));
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------- wiring --- */

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void save();
  });
  pubBtn.addEventListener('click', () => {
    void togglePublish();
  });
  newBtn.addEventListener('click', startNew);

  return {
    root,
    refresh: refreshList,
    clearEditor,
    clearAll(): void {
      items = [];
      clearEditor();
      renderTable();
    },
    isDirty,
    isBusy: () => busy,
    bumpSeq(): void {
      loadSeq += 1;
    },
    setError: setErr,
  };
}

/* ------------------------------------------------------------- specs --- */

function postsSpec(): PanelSpec<PostView, PostChanges> {
  return {
    id: 'posts',
    label: 'Posts',
    noun: 'post',
    emptyText: 'no posts yet — write the first one',
    duplicateMsg: 'a post with this slug already exists — change the title',
    fields: [
      { key: 'title', label: 'title', kind: 'input' },
      { key: 'deck', label: 'deck', kind: 'input' },
      { key: 'tags', label: 'tags', kind: 'input', hint: 'comma-separated' },
      { key: 'body', label: 'body', kind: 'area', rows: 16, hint: MD_HINT, preview: true },
    ],
    toBase: (p) => ({ title: p.title, deck: p.deck, tags: p.tags.join(', '), body: p.body ?? '' }),
    diff: (base, f) => {
      const changes: PostChanges = {};
      if (f.title !== base.title) changes.title = f.title.trim();
      if (f.deck !== base.deck) changes.deck = f.deck.trim();
      if (JSON.stringify(parseTags(f.tags)) !== JSON.stringify(parseTags(base.tags))) {
        changes.tags = parseTags(f.tags);
      }
      if (f.body !== base.body) changes.body = f.body;
      return Object.keys(changes).length ? changes : null;
    },
    validateNew: (f) =>
      !f.title.trim() || !f.deck.trim() ? 'title and deck are both required' : null,
    create: (t, f) =>
      adminCreatePost(t, {
        title: f.title.trim(),
        deck: f.deck.trim(),
        tags: parseTags(f.tags),
        body: f.body.trim() ? f.body : undefined,
        draft: true,
      }),
    fetchAll: adminFetchPosts,
    fetchOne: adminFetchPost,
    fetchEvents: adminFetchEvents,
    revise: adminRevisePost,
    publish: adminPublishPost,
    unpublish: adminUnpublishPost,
  };
}

/* ---------------------------------------------------- picture validation
   The console says NO before the API has to. Both gates are the ones the
   API itself applies (format, count) plus one it cannot: a token this
   build does not carry would render as nothing at all, and the console is
   served BY this build, so it knows. */

/** ' — try one of: …' when the registry has neighbours worth naming. */
function tokenHint(ref: string): string {
  const token = ref.slice('asset:'.length);
  const cut = token.indexOf('/');
  const folder = cut > 0 ? token.slice(0, cut) : '';
  const near = folder
    ? ASSET_TOKENS.filter((t) => t.startsWith(folder + '/'))
    : ASSET_TOKENS.filter((t) => !t.includes('/'));
  if (near.length === 0) return '';
  return ' — this build carries: ' + near.slice(0, 4).join(', ') + (near.length > 4 ? ', …' : '');
}

/** null when the reference is usable, else the sentence that says why not. */
function badRef(ref: string, where: string): string | null {
  if (!isImageRef(ref)) {
    return `${where}: '${ref}' is neither an https:// URL nor an 'asset:<token>' reference`;
  }
  if (isUnknownAssetRef(ref)) {
    return `${where}: '${ref}' names no image in this build${tokenHint(ref)}`;
  }
  return null;
}

/**
 * The textarea, line by line — errors quote the line NUMBER the maintainer
 * is looking at, so blank lines and skipped entries never shift the count.
 */
function validateGallery(src: string): string | null {
  const lines = src.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') continue;
    count += 1;
    const bar = raw.indexOf('|');
    const ref = (bar < 0 ? raw : raw.slice(0, bar)).trim();
    const where = 'gallery line ' + (i + 1);
    if (ref === '') return `${where}: a caption with no picture in front of the '|'`;
    const bad = badRef(ref, where);
    if (bad !== null) return bad;
  }
  if (count > GALLERY_MAX_ENTRIES) {
    return `gallery holds ${count} pictures — the limit is ${GALLERY_MAX_ENTRIES}`;
  }
  return null;
}

function pagesSpec(): PanelSpec<PageView, PageChanges> {
  return {
    id: 'pages',
    label: 'Pages',
    noun: 'page',
    emptyText: 'no pages yet — an empty list is a real state',
    duplicateMsg: 'this slug already exists (pages and posts share one namespace) — change the title',
    fields: [
      { key: 'title', label: 'title', kind: 'input' },
      {
        key: 'summary',
        label: 'summary',
        kind: 'input',
        count: PAGE_SUMMARY_MAX,
        placeholder: 'one line of card copy',
        hint: `card copy — ${PAGE_SUMMARY_MAX} characters max; empty falls back to the first body paragraph`,
      },
      {
        key: 'image',
        label: 'image',
        kind: 'input',
        placeholder: 'https://… or asset:maintainer',
        hint: "card image — an https:// URL, or 'asset:<token>' for an image bundled with the frontend",
      },
      {
        key: 'gallery',
        label: 'gallery',
        kind: 'area',
        rows: 6,
        placeholder: 'asset:eleva-app/org-chart-editor|Org chart editor',
        hint: `one picture per line — 'asset:<token>' or an https:// URL, an optional |caption after it; ${GALLERY_MAX_ENTRIES} max; empty clears the strip`,
      },
      {
        key: 'repo',
        label: 'repo',
        kind: 'input',
        placeholder: 'owner/name',
        hint: 'GitHub repository — the widget renders public metadata, and says PRIVATE (no link) for a repo the public cannot open; empty clears it',
      },
      { key: 'body', label: 'body', kind: 'area', rows: 18, hint: MD_HINT, preview: true },
    ],
    toBase: (p) => ({
      title: p.title,
      summary: p.summary ?? '',
      image: p.image ?? '',
      gallery: formatGalleryLines(p.gallery ?? []),
      repo: p.repo ?? '',
      body: p.body ?? '',
    }),
    diff: (base, f) => {
      const changes: PageChanges = {};
      if (f.title !== base.title) changes.title = f.title.trim();
      if (f.summary.trim() !== base.summary.trim()) changes.summary = f.summary.trim();
      if (f.image.trim() !== base.image.trim()) changes.image = f.image.trim();
      /* the strip is compared PARSED, so reordering a line matters and
         re-typing the same list in a different whitespace does not */
      const gallery = parseGalleryLines(f.gallery);
      if (JSON.stringify(gallery) !== JSON.stringify(parseGalleryLines(base.gallery))) {
        changes.gallery = gallery; /* [] is the clear gesture */
      }
      if (f.repo.trim() !== base.repo.trim()) changes.repo = f.repo.trim();
      if (f.body !== base.body) changes.body = f.body;
      return Object.keys(changes).length ? changes : null;
    },
    validateNew: (f) => (f.title.trim() ? null : 'title is required'),
    validate: (f) => {
      if (f.summary.trim().length > PAGE_SUMMARY_MAX) {
        return `summary is ${f.summary.trim().length} characters — the limit is ${PAGE_SUMMARY_MAX}`;
      }
      const image = f.image.trim();
      if (image !== '') {
        const bad = badRef(image, 'image');
        if (bad !== null) return bad;
      }
      const badGallery = validateGallery(f.gallery);
      if (badGallery !== null) return badGallery;
      const repo = f.repo.trim();
      if (repo !== '' && !isRepoRef(repo)) {
        return "repo must read 'owner/name' — letters, digits, dot, dash and underscore only (no https:// prefix, no trailing .git)";
      }
      return null;
    },
    create: (t, f) => {
      const gallery = parseGalleryLines(f.gallery);
      return adminCreatePage(t, {
        title: f.title.trim(),
        body: f.body,
        summary: f.summary.trim() || undefined,
        image: f.image.trim() || undefined,
        gallery: gallery.length ? gallery : undefined,
        repo: f.repo.trim() || undefined,
        draft: true,
      });
    },
    fetchAll: adminFetchPages,
    fetchOne: adminFetchPage,
    fetchEvents: adminFetchPageEvents,
    revise: adminRevisePage,
    publish: adminPublishPage,
    unpublish: adminUnpublishPage,
  };
}

/* --------------------------------------------------------------- room --- */

export interface MaintainHandle {
  destroy(): void;
}

export function initMaintain(reduced: () => boolean): MaintainHandle {
  const room = el('div', 'mt-room');
  room.hidden = true;
  room.setAttribute('role', 'dialog');
  room.setAttribute('aria-modal', 'true');
  room.tabIndex = -1;
  applyTokens(room, THEME_ID, accentOf(THEME_ID, null));

  const scroller = el('div', 'mt-scroll');
  room.appendChild(scroller);
  const col = el('div', 'mt-col');
  scroller.appendChild(col);

  const head = el('header', 'mt-head');
  const headText = el('div', 'mt-head-text');
  headText.appendChild(el('p', 'mt-kicker', 'Maintainer console'));
  const title = el('h2', 'mt-title', 'Content — append-only');
  title.id = 'mt-title';
  room.setAttribute('aria-labelledby', title.id);
  headText.appendChild(title);
  head.appendChild(headText);
  const logoutBtn = el('button', 'mt-btn mt-btn--ghost mt-logout', 'log out');
  logoutBtn.type = 'button';
  logoutBtn.hidden = true;
  head.appendChild(logoutBtn);
  col.appendChild(head);

  const closeBtn = el('button', 'mt-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close console — back to the site');
  room.appendChild(closeBtn);

  /* ------------------------------------------------------------ gate --- */

  const gate = el('div', 'mt-gate');
  const gateForm = el('form', 'mt-gate-box');
  gateForm.appendChild(
    el(
      'p',
      'mt-gate-lede',
      'maintainer access — the token stays in this tab (sessionStorage) and travels only as a header',
    ),
  );
  const gateField = el('div', 'mt-field');
  const gateLabel = el('label', 'mt-label', 'admin token');
  gateLabel.htmlFor = 'mt-token';
  const gateInput = el('input', 'mt-input');
  gateInput.type = 'password';
  gateInput.id = 'mt-token';
  gateInput.name = 'admin-token';
  gateInput.autocomplete = 'off';
  gateInput.required = true;
  gateField.appendChild(gateLabel);
  gateField.appendChild(gateInput);
  gateForm.appendChild(gateField);
  const gateBtn = el('button', 'mt-btn', 'connect');
  gateBtn.type = 'submit';
  gateForm.appendChild(gateBtn);
  const gateErr = el('p', 'mt-gate-err');
  gateErr.setAttribute('role', 'alert');
  gateErr.hidden = true;
  gateForm.appendChild(gateErr);
  gate.appendChild(gateForm);
  col.appendChild(gate);

  /* --------------------------------------------------------- console --- */

  const consoleEl = el('div', 'mt-console');
  consoleEl.hidden = true;
  col.appendChild(consoleEl);

  /* ----------------------------------------------------------- state --- */

  let openState = false;
  let token: string | null = null;
  let returnFocusTo: HTMLElement | null = null;
  let savedScrollY = 0;
  let lockedView: HTMLElement | null = null;

  const deps: PanelDeps = {
    getToken: () => token,
    onBusyChange(): void {
      logoutBtn.disabled = panels.some((p) => p.isBusy());
    },
  };

  const postsPanel = makePanel(postsSpec(), deps);
  const pagesPanel = makePanel(pagesSpec(), deps);
  const panels: PanelHandle[] = [postsPanel, pagesPanel];

  /* ------------------------------------------------------------ tabs --- */

  const tabbar = el('div', 'mt-tabs');
  tabbar.setAttribute('role', 'tablist');
  tabbar.setAttribute('aria-label', 'Content types');
  consoleEl.appendChild(tabbar);

  interface TabDef {
    id: string;
    btn: HTMLButtonElement;
    panel: PanelHandle;
  }
  const tabs: TabDef[] = [];

  function showTab(id: string): void {
    for (const t of tabs) {
      const on = t.id === id;
      t.btn.setAttribute('aria-selected', String(on));
      t.btn.tabIndex = on ? 0 : -1;
      t.btn.classList.toggle('is-active', on);
      t.panel.root.hidden = !on;
    }
  }

  function addTab(id: string, label: string, panel: PanelHandle): void {
    const btn = el('button', 'mt-tab', label);
    btn.type = 'button';
    btn.id = 'mt-tab-' + id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', panel.root.id);
    btn.addEventListener('click', () => {
      showTab(id);
    });
    tabbar.appendChild(btn);
    consoleEl.appendChild(panel.root);
    tabs.push({ id, btn, panel });
  }

  addTab('posts', 'Posts', postsPanel);
  addTab('pages', 'Pages', pagesPanel);
  showTab('posts');

  /* roving tabindex: arrows move focus AND selection (a hidden tab keeps
     its editor state, so switching is always safe) */
  tabbar.addEventListener('keydown', (e) => {
    const idx = tabs.findIndex((t) => t.btn === document.activeElement);
    if (idx < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next >= 0) {
      e.preventDefault();
      showTab(tabs[next].id);
      tabs[next].btn.focus();
    }
  });

  /* --------------------------------------------------------- gating --- */

  function setGateErr(msg: string | null): void {
    gateErr.hidden = msg === null;
    gateErr.textContent = msg ?? '';
  }

  function showGate(err: string | null): void {
    token = null;
    gate.hidden = false;
    consoleEl.hidden = true;
    logoutBtn.hidden = true;
    gateInput.value = '';
    setGateErr(err);
  }

  function showConsole(): void {
    gate.hidden = true;
    consoleEl.hidden = false;
    logoutBtn.hidden = false;
  }

  /** Both tables, side by side; posts doubles as the auth check (401/503
      falls back to the gate), pages failures stay in that panel's strip. */
  function loadPanels(t: string): void {
    void postsPanel.refresh(t).catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 401 || e.status === 503)) {
        writeToken(null);
        showGate(
          e.status === 401 ? 'stored token rejected — reconnect' : 'admin disabled on this server',
        );
        gateInput.focus();
      } else {
        postsPanel.setError(describe(e, 'could not load posts'));
      }
    });
    void pagesPanel.refresh(t).catch((e: unknown) => {
      pagesPanel.setError(describe(e, 'could not load pages'));
    });
  }

  async function connect(): Promise<void> {
    const t = gateInput.value.trim();
    if (!t) {
      setGateErr('enter the admin token');
      return;
    }
    setGateErr(null);
    gateBtn.disabled = true;
    gateBtn.textContent = 'connecting…';
    try {
      await adminFetchPosts(t); /* the token check */
      token = t;
      writeToken(t);
      gateInput.value = '';
      for (const p of panels) p.clearAll();
      showConsole();
      room.focus();
      loadPanels(t);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setGateErr('token rejected — check it and try again');
      } else if (e instanceof ApiError && e.status === 503) {
        setGateErr('admin disabled on this server');
      } else {
        setGateErr('could not reach the API — is the server up?');
      }
    } finally {
      gateBtn.disabled = false;
      gateBtn.textContent = 'connect';
    }
  }

  function confirmDiscardAll(): boolean {
    if (!panels.some((p) => p.isDirty())) return true;
    return window.confirm('discard unsaved changes?');
  }

  function logout(): void {
    if (panels.some((p) => p.isBusy())) return;
    if (!confirmDiscardAll()) return;
    writeToken(null);
    token = null;
    for (const p of panels) p.clearAll();
    showGate(null);
    gateInput.focus();
  }

  /* ------------------------------------------------ room open/close --- */

  function openRoom(): void {
    if (openState) return;
    openState = true;
    const active = document.activeElement;
    returnFocusTo = active instanceof HTMLElement && active !== document.body ? active : null;
    savedScrollY = window.scrollY;
    lockedView = document.querySelector<HTMLElement>('.vw.is-active');
    lockScroll(lockedView); /* deck track + the active view, ref-counted */
    room.hidden = false;
    scroller.scrollTop = 0;
    if (!reduced()) {
      /* OPACITY, not autoAlpha — see pageRoom.ts: gsap renders a fromTo's
         start state synchronously, and autoAlpha's zero writes
         visibility:hidden, which the browser refuses to focus, so the
         room.focus() / gateInput.focus() below would no-op. '[hidden]'
         does the hiding. */
      gsap.fromTo(
        room,
        { opacity: 0 },
        { opacity: 1, duration: 0.3, ease: 'power1.out', clearProps: 'opacity,visibility' },
      );
    }
    const stored = readToken();
    if (stored !== null) {
      token = stored;
      for (const p of panels) p.clearEditor();
      showConsole();
      room.focus();
      loadPanels(stored);
    } else {
      showGate(null);
      gateInput.focus();
    }
  }

  function closeRoom(): void {
    if (!openState) return;
    /* a lightbox opened from a markdown preview goes first — it releases
       its own (ref-counted) lock before the console releases the room's */
    closeLightbox();
    openState = false;
    for (const p of panels) p.bumpSeq(); /* drop in-flight loads */
    gsap.killTweensOf(room);
    gsap.set(room, { clearProps: 'opacity,visibility' });
    room.hidden = true;
    unlockScroll(lockedView);
    lockedView = null;
    /* leaving via '#' the browser jumps to top — put the deck back */
    window.scrollTo(0, savedScrollY);
    const target = returnFocusTo;
    returnFocusTo = null;
    if (target && target.isConnected) target.focus();
  }

  /** Escape / the close control — a dirty editor gets one confirm(). */
  function requestClose(): void {
    if (!openState) return;
    if (!confirmDiscardAll()) return;
    location.hash = '';
  }

  function route(): void {
    if (location.hash === ROUTE) openRoom();
    else closeRoom();
  }

  /* ------------------------------------------------------- wiring --- */

  gateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void connect();
  });
  logoutBtn.addEventListener('click', logout);
  closeBtn.addEventListener('click', requestClose);

  document.body.appendChild(room);

  const onHashChange = (): void => route();
  window.addEventListener('hashchange', onHashChange);

  /* capture phase, like the reading room: the deck's global Escape (scroll
     to overview) sees defaultPrevented and stands down */
  const onDocKeydown = (e: KeyboardEvent): void => {
    /* a lightbox (a picture opened from a markdown preview) is the topmost
       room while it is up: Escape closes THAT, and the console stays */
    if (e.key === 'Escape' && openState && !isLightboxOpen()) {
      e.preventDefault();
      requestClose();
    }
  };
  document.addEventListener('keydown', onDocKeydown, true);

  /* deep link on initial page load — deferred a microtask so the deck can
     seat the scrollbar first (same idiom as the reading room) */
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

export default initMaintain;
