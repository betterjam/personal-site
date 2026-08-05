/**
 * CONTROL PANEL — the iac section IS the ops console demo (echoes
 * Diego's real infra ops panel). Ported whole from
 * mockup 07: tiered architecture strip with an animated packet, white
 * service cards with On/Off power pills (role=switch), nodeSync dimming,
 * a scheduling-rules table with toggles, 'built by Diego' microcopy.
 * All demo state is local — flipping Api off dims its node and stops
 * the flow.
 *
 * Entrance (deck lifecycle): when the view lands, the head rises, the
 * console lands, nodes and wires draw in left-to-right (scaleX /
 * opacity stagger), then the service cards rise, then the rules, then
 * the item cards. The headline belongs to the particle morph — the
 * deck reveals it. The packet loop NEVER runs offstage: it starts only
 * while the view is displayed (onEnter) and pauses on onLeave.
 * Reduced motion: everything visible immediately, packet parked
 * mid-wire (CSS .is-rm), pills/switches still work.
 */
import '../styles/controlPanel.css';
import { gsap } from 'gsap';
import { inlineItems } from '../engine/data';
import { pageLink, type SectionBuilder } from './types';

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

type NodeKey = 'service' | 'database';

interface Svc {
  name: string;
  type: string;
  node: NodeKey | null;
  chipOn: string;
  chipOff: string;
  on: boolean;
}

export const buildControlPanel: SectionBuilder = (host, section, _index, ctx) => {
  /* page blocks are a showcase/markdown feature — this band reads the
     inline items and is untouched by the item union */
  const copyItems = inlineItems(section);
  const themeId = ctx.mix.theme;
  const wrap = el('section', 'vw vw-cp');
  wrap.id = 'vw-' + section.id;
  ctx.applyTokens(wrap, themeId, ctx.accentOf(themeId, section.id));

  const col = el('div', 'mx-col');
  wrap.appendChild(col);

  const head = el('div', 'mx-head');
  const kick = el('p', 'cp-kicker', section.kicker);
  const headline = el('h2', 'cp-headline', section.headline);
  headline.id = 'hl-' + section.id;
  wrap.setAttribute('aria-labelledby', headline.id);
  const sum = el('p', 'cp-summary', section.summary);
  const plink = pageLink(section.id);
  head.append(kick, headline, sum, plink);
  col.appendChild(head);

  const console_ = el('div', 'cp-console');
  const conhead = el('div', 'cp-conhead');
  conhead.appendChild(el('span', null, 'infra control panel — live demo'));
  conhead.appendChild(el('span', 'cp-note', 'built by Diego'));
  console_.appendChild(conhead);

  /* ------------------- mini tiered architecture strip ------------------- */

  const archwrap = el('div', 'cp-archwrap');
  const arch = el('div', 'cp-arch');
  const flow = el('div', 'cp-flow');
  const packet = el('span', 'cp-packet');
  packet.setAttribute('aria-hidden', 'true');
  flow.appendChild(packet);
  arch.appendChild(flow);

  const NODES = ['Traffic', 'Edge', 'Service', 'Database'];
  const nodeEls: Record<string, HTMLElement> = {};
  const archNodes: HTMLElement[] = [];
  const archWires: HTMLElement[] = [];
  /** Nodes and wires in visual left-to-right order for the draw-in. */
  const archSeq: HTMLElement[] = [];
  NODES.forEach((nm, i) => {
    if (i > 0) {
      const wire = el('i', 'cp-wire');
      arch.appendChild(wire);
      archWires.push(wire);
      archSeq.push(wire);
    }
    const node = el('span', 'cp-node');
    node.appendChild(el('i', 'cp-node-dot'));
    node.appendChild(el('span', null, nm));
    arch.appendChild(node);
    nodeEls[nm.toLowerCase()] = node;
    archNodes.push(node);
    archSeq.push(node);
  });
  archwrap.appendChild(arch);
  console_.appendChild(archwrap);

  /* ------------------ service cards — demo state is local --------------- */

  const SVCS: Svc[] = [
    { name: 'api', type: 'ecs', node: 'service', chipOn: '1/1 running', chipOff: 'stopped', on: true },
    { name: 'web', type: 'ecs', node: 'service', chipOn: '1/1 running', chipOff: 'stopped', on: true },
    { name: 'database', type: 'rds', node: 'database', chipOn: 'available', chipOff: 'stopped', on: true },
    { name: 'status', type: 'info', node: null, chipOn: 'online', chipOff: 'offline', on: true },
  ];
  const svcGrid = el('div', 'cp-svcs');
  const svcCards: HTMLElement[] = [];

  let flowTween: gsap.core.Tween | null = null;
  let flowW = 0;
  const setPacketX = gsap.quickSetter(packet, 'x', 'px') as (value: number) => void;
  /** Band inside the active scroll belt (spine onEnter/onLeave). */
  let active = false;
  /** Entrance finished (or reduced motion) — the packet may fly. */
  let revealed = false;

  function measureFlow(): void {
    flowW = flow.offsetWidth;
  }

  function nodeSync(): void {
    /* a node dims as soon as ANY service it hosts is off — flipping Api
       off dims the Service tier, in step with the packet flow stopping */
    const byNode: Record<NodeKey, boolean[]> = { service: [], database: [] };
    for (const svc of SVCS) {
      if (svc.node) byNode[svc.node].push(svc.on);
    }
    (Object.keys(byNode) as NodeKey[]).forEach((key) => {
      const allOn = byNode[key].every((v) => v);
      nodeEls[key].classList.toggle('is-dim', !allOn);
    });
  }

  function flowRunning(): boolean {
    return SVCS.every((svc) => svc.on);
  }

  function syncFlow(): void {
    const running = flowRunning();
    arch.classList.toggle('is-down', !running);
    if (ctx.reduced()) {
      wrap.classList.add('is-rm');
      if (flowTween) {
        flowTween.kill();
        flowTween = null;
        gsap.set(packet, { clearProps: 'transform' });
      }
      return;
    }
    wrap.classList.remove('is-rm');
    if (running && active && revealed) {
      measureFlow();
      if (!flowTween) {
        const prox = { p: 0 };
        flowTween = gsap.to(prox, {
          p: 1,
          duration: 3.2,
          ease: 'none',
          repeat: -1,
          onUpdate: () => setPacketX(prox.p * flowW),
        });
      }
      flowTween.play();
    } else if (flowTween) {
      flowTween.pause();
    }
  }

  for (const svc of SVCS) {
    const card = el('article', 'cp-svc');
    const top = el('div', 'cp-svc-top');
    top.appendChild(el('i', 'cp-dot'));
    top.appendChild(el('span', 'cp-svc-name', svc.name));
    top.appendChild(el('span', 'cp-type', svc.type));
    card.appendChild(top);
    const bot = el('div', 'cp-svc-bot');
    const chip = el('span', 'cp-chip', svc.chipOn);
    const pill = el('button', 'cp-pill is-on');
    pill.type = 'button';
    pill.setAttribute('role', 'switch');
    pill.setAttribute('aria-checked', 'true');
    pill.setAttribute('aria-label', svc.name + ' power');
    const pillTxt = el('span', 'cp-pill-txt', 'on');
    pill.appendChild(el('span', 'cp-pill-knob'));
    pill.appendChild(pillTxt);
    pill.addEventListener('click', () => {
      svc.on = !svc.on;
      pill.classList.toggle('is-on', svc.on);
      pill.setAttribute('aria-checked', svc.on ? 'true' : 'false');
      pillTxt.textContent = svc.on ? 'on' : 'off';
      chip.textContent = svc.on ? svc.chipOn : svc.chipOff;
      card.classList.toggle('is-off', !svc.on);
      nodeSync();
      syncFlow();
    });
    bot.appendChild(chip);
    bot.appendChild(pill);
    card.appendChild(bot);
    svcGrid.appendChild(card);
    svcCards.push(card);
  }
  console_.appendChild(svcGrid);

  /* --------------------------- scheduling rules -------------------------- */

  const rules = el('div', 'cp-rules');
  const rulesTitle = el('p', 'cp-rules-title', 'Scheduling rules');
  rules.appendChild(rulesTitle);
  const ruleRows: HTMLElement[] = [];
  for (const rule of [
    { name: 'evening-off', when: '21:00 weekdays', what: 'all services OFF' },
    { name: 'morning-on', when: '07:00 weekdays', what: 'all services ON' },
  ]) {
    const row = el('div', 'cp-rule');
    row.appendChild(el('span', 'cp-rule-name', rule.name));
    row.appendChild(el('span', 'cp-rule-when', rule.when));
    row.appendChild(el('span', 'cp-rule-what', rule.what));
    const sw = el('button', 'cp-switch is-on');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'true');
    sw.setAttribute('aria-label', rule.name + ' rule');
    sw.appendChild(el('span', 'cp-switch-knob'));
    sw.addEventListener('click', () => {
      const on = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    row.appendChild(sw);
    rules.appendChild(row);
    ruleRows.push(row);
  }
  console_.appendChild(rules);
  col.appendChild(console_);

  /* ------------- the section's items as console descriptions ------------ */

  const items = el('div', 'cp-items');
  const itemCards: HTMLElement[] = [];
  for (const it of copyItems) {
    const card = el('article', 'cp-item');
    card.appendChild(el('h3', 'cp-item-title', it.title));
    card.appendChild(el('p', 'cp-item-deck', it.deck));
    const tags = el('p', 'cp-item-tags');
    for (const t of it.tags ?? []) tags.appendChild(el('span', null, t));
    card.appendChild(tags);
    items.appendChild(card);
    itemCards.push(card);
  }
  col.appendChild(items);

  host.appendChild(wrap);
  if (ctx.reduced()) wrap.classList.add('is-rm');

  /* ------------------------------ entrance ------------------------------ */

  const headRise: HTMLElement[] = [kick, sum, plink]; /* headline is the morph's */
  const risers: HTMLElement[] = [...svcCards, rulesTitle, ...ruleRows, ...itemCards];
  const everything: (HTMLElement | Element)[] = [
    ...headRise,
    console_,
    ...archNodes,
    ...archWires,
    packet,
    ...risers,
  ];
  let tl: gsap.core.Timeline | null = null;

  function killEntrance(): void {
    if (tl) {
      tl.kill();
      tl = null;
    }
    gsap.killTweensOf(everything);
  }

  function showInstant(): void {
    killEntrance();
    gsap.set(everything, { clearProps: 'opacity,visibility,transform' });
    revealed = true;
    syncFlow();
  }

  function play(): void {
    killEntrance();
    if (ctx.reduced()) {
      showInstant();
      return;
    }
    const t = gsap.timeline({
      onComplete() {
        revealed = true;
        syncFlow();
      },
    });
    tl = t;
    t.to(
      headRise,
      { opacity: 1, y: 0, duration: 0.55, stagger: 0.09, ease: 'power2.out', clearProps: 'opacity,transform' },
      0,
    );
    t.to(
      console_,
      { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', clearProps: 'opacity,transform' },
      0.22,
    );
    /* nodes and wires draw in left-to-right */
    const archAt = 0.42;
    const archStep = 0.09;
    archSeq.forEach((n, i) => {
      const at = archAt + i * archStep;
      if (n.classList.contains('cp-wire')) {
        t.to(n, { opacity: 1, scaleX: 1, duration: 0.35, ease: 'power2.out', clearProps: 'opacity,transform' }, at);
      } else {
        t.to(n, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out', clearProps: 'opacity,transform' }, at);
      }
    });
    const archEnd = archAt + archSeq.length * archStep + 0.2;
    t.to(packet, { opacity: 1, duration: 0.3, ease: 'none', clearProps: 'opacity' }, archEnd - 0.1);
    /* then the cards rise... */
    t.to(
      svcCards,
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: 'power2.out', clearProps: 'opacity,transform' },
      archEnd,
    );
    /* ...then the rules... */
    t.to(
      [rulesTitle, ...ruleRows],
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: 'power2.out', clearProps: 'opacity,transform' },
      archEnd + 0.28,
    );
    /* ...then the console descriptions */
    t.to(
      itemCards,
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: 'power2.out', clearProps: 'opacity,transform' },
      archEnd + 0.5,
    );
  }

  /* ------------------------------ listeners ------------------------------ */

  const onResize = (): void => {
    measureFlow();
  };
  window.addEventListener('resize', onResize);

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onMotionChange = (): void => {
    if (ctx.reduced()) showInstant();
    else syncFlow();
  };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onMotionChange);
  }

  return {
    el: wrap,
    headline,
    prepareEntrance() {
      if (ctx.reduced()) {
        revealed = true; /* visible immediately; packet parked via .is-rm */
        return;
      }
      killEntrance();
      revealed = false;
      syncFlow(); /* the packet holds while the console redraws */
      gsap.set(headRise, { opacity: 0, y: 24 });
      gsap.set(console_, { opacity: 0, y: 24 });
      gsap.set(archNodes, { opacity: 0, y: 10 });
      gsap.set(archWires, { opacity: 0, scaleX: 0, transformOrigin: 'left center' });
      gsap.set(packet, { opacity: 0 });
      gsap.set(risers, { opacity: 0, y: 22 });
    },
    playEntrance: play,
    onEnter() {
      active = true;
      syncFlow();
    },
    onLeave() {
      active = false;
      syncFlow(); /* pause the packet — never run offstage */
    },
    destroy() {
      window.removeEventListener('resize', onResize);
      if (typeof mq.removeEventListener === 'function') {
        mq.removeEventListener('change', onMotionChange);
      }
      if (flowTween) {
        flowTween.kill();
        flowTween = null;
      }
      killEntrance();
      gsap.killTweensOf(packet);
    },
  };
};

export default buildControlPanel;
