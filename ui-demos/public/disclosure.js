const transitions = new WeakMap();

// Keep outgoing content mounted until it has folded away. A newer toggle owns cleanup.
export async function setDisclosure(panel, open, immediate = false) {
  const previous = transitions.get(panel);
  const height = panel.hidden ? 0 : panel.getBoundingClientRect().height;
  const opacity = panel.hidden ? 0 : Number(getComputedStyle(panel).opacity);
  previous?.animation?.cancel();
  const current = {};
  transitions.set(panel, current);
  panel.inert = !open;
  panel.setAttribute('aria-hidden', String(!open));
  if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches || !panel.animate) {
    panel.hidden = !open;
    panel.style.overflow = '';
    transitions.delete(panel);
    return true;
  }
  panel.hidden = false;
  panel.style.overflow = 'hidden';
  // Let a cached summary render before measuring the expanded content.
  await new Promise(requestAnimationFrame);
  if (transitions.get(panel) !== current) return false;
  current.animation = panel.animate([
    { height: `${height}px`, opacity },
    { height: `${open ? panel.scrollHeight : 0}px`, opacity: open ? 1 : 0 },
  ], { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' });
  try { await current.animation.finished; } catch { return false; }
  if (transitions.get(panel) !== current) return false;
  panel.hidden = !open;
  current.animation.cancel();
  panel.style.overflow = '';
  transitions.delete(panel);
  return true;
}
