/**
 * SHOT FRAME — the browser-chrome frame, drawn once.
 *
 * A graphite bar with three dots and a mono address label, a body that
 * holds whatever is being shown (a real capture, an illustrative mock),
 * and an optional mono caption underneath. The projects showcase invented
 * it; the reading room's hero shot and the markdown '!image[…]' figure
 * wear the SAME component rather than a second implementation of it.
 *
 * Like engine/pageCard.ts it hardcodes no palette: everything is drawn
 * from `currentColor`, the surrounding finish's `--accent`/`--font-*`, and
 * ONE local token the host sets —
 *
 *     --sf-paper: the surface the frame sits on (var(--p-bone) in the
 *     Seafoam rooms, var(--p-stage) in the console, var(--p-paper) in the
 *     Sunburst room). It is what the chrome bar's dots and label are cut
 *     out of, so it cannot be derived from currentColor. Defaults to the
 *     browser's Canvas color when a host forgets.
 */
import '../styles/shotFrame.css';

export interface ShotFrameContent {
  /** The mono label in the chrome bar — a route, a token, a host. */
  addr: string;
  /** One honest mono line under the frame; omitted when there is none. */
  caption?: string;
  /** The frame's contents: an <img>, an SVG mock, a button wrapping one. */
  body: HTMLElement;
}

export interface ShotFrame {
  /** The whole thing — a <figure>; append this. */
  figure: HTMLElement;
  frame: HTMLElement;
  /** The slot the body lives in; paintShotFrame swaps its contents. */
  body: HTMLElement;
  addr: HTMLElement;
  caption: HTMLElement;
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

/** The empty frame. Pass content now, or paint it later (the showcase
    builds its rows before the pages they show have resolved). */
export function createShotFrame(content?: ShotFrameContent, className?: string): ShotFrame {
  const figure = el('figure', 'sf-shot' + (className ? ' ' + className : ''));
  const frame = el('div', 'sf-frame');
  const chrome = el('div', 'sf-chrome');
  for (let d = 0; d < 3; d++) chrome.appendChild(el('i', 'sf-dot'));
  const addr = el('span', 'sf-addr');
  chrome.appendChild(addr);
  frame.appendChild(chrome);
  const body = el('div', 'sf-body');
  frame.appendChild(body);
  figure.appendChild(frame);
  const caption = el('figcaption', 'sf-caption');
  figure.appendChild(caption);
  const shot: ShotFrame = { figure, frame, body, addr, caption };
  if (content) paintShotFrame(shot, content);
  return shot;
}

/** Swap what a frame shows — the ONE place art, address and caption change. */
export function paintShotFrame(shot: ShotFrame, content: ShotFrameContent): void {
  shot.body.textContent = '';
  shot.body.appendChild(content.body);
  shot.addr.textContent = content.addr;
  shot.caption.textContent = content.caption ?? '';
  shot.caption.hidden = !content.caption;
}

/** A real capture: intrinsics declared for layout stability, never eager. */
export function frameImage(url: string, alt: string, w: number, h: number): HTMLImageElement {
  const img = el('img', 'sf-img');
  img.src = url;
  img.alt = alt;
  if (w && h) {
    img.width = w;
    img.height = h;
  }
  /* attributes, not properties: the parser acts on them the moment the
     node lands, whatever the engine reflects */
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
  img.draggable = false;
  return img;
}

export default createShotFrame;
