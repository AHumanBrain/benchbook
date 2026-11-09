// Small messages at the bottom of the screen, with an optional Undo. Replaces alert() and "are you sure?" pop-ups.

let host = null;

function container() {
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

/** toast('Deleted "Batch 1".', { undo: () => restore() }). kind: info | warn | error. Returns a function that closes it. */
export function toast(message, { kind = 'info', undo = null, ms } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const text = document.createElement('span');
  text.className = 'msg';
  text.textContent = message;
  el.append(text);
  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  const button = (label, cls, onClick, aria) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    el.append(b);
  };
  if (undo) button('Undo', 'undo', () => { close(); undo(); });
  button('×', 'x', close, 'Dismiss');
  const box = container();
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  const duration = ms ?? (kind === 'error' ? 12000 : undo ? 9000 : 5000);
  const start = () => { clearTimeout(timer); timer = setTimeout(close, duration); };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', start);
  start();
  return close;
}
