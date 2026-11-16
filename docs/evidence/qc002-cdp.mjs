// Minimal Chrome DevTools Protocol client for driving the Electron dev window
// (`node apps/mac/scripts/dev.mjs --remote-debugging-port=9333`). Node 24 has a global WebSocket.
import fs from 'node:fs';

export async function connectPage(port = 9333) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const screenshot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  const key = (k, code, keyCode, modifiers = 0) =>
    send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: k,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
    }).then(() =>
      send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: k,
        code,
        windowsVirtualKeyCode: keyCode,
        modifiers,
      }),
    );
  return { send, evaluate, screenshot, key, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
