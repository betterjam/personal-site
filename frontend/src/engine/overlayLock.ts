/**
 * Shared scroll lock for body-level overlays (the blog reading room,
 * the maintainer console). Each overlay locks BOTH the body (the deck
 * track — scrollLocked() in scroll.ts keys off body overflow) and one
 * inner scroller (the active view).
 *
 * Ref-counted so overlays can overlap for a single hashchange dispatch
 * (#/maintain → #/blog/… fires one router's open before the other's
 * close, in listener order): the body stays locked until the LAST
 * overlay releases, and the first lock's saved value — never a
 * transient 'hidden' — is what gets restored. Views are counted per
 * element for the same reason.
 */

let bodyLocks = 0;
let savedBodyOverflow = '';

interface ViewSave {
  count: number;
  saved: string;
}
const viewSaves = new Map<HTMLElement, ViewSave>();

export function lockScroll(view: HTMLElement | null): void {
  if (bodyLocks === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  bodyLocks += 1;
  if (view) {
    const entry = viewSaves.get(view);
    if (entry) {
      entry.count += 1;
    } else {
      viewSaves.set(view, { count: 1, saved: view.style.overflow });
      view.style.overflow = 'hidden';
    }
  }
}

export function unlockScroll(view: HTMLElement | null): void {
  if (bodyLocks > 0) {
    bodyLocks -= 1;
    if (bodyLocks === 0) document.body.style.overflow = savedBodyOverflow;
  }
  if (view) {
    const entry = viewSaves.get(view);
    if (entry) {
      entry.count -= 1;
      if (entry.count <= 0) {
        view.style.overflow = entry.saved;
        viewSaves.delete(view);
      }
    }
  }
}
