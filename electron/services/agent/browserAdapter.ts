import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';

/** Bounded web-context reader with no preload, host tools, or persisted cookies. */
export class BrowserAdapter {
  async inspect(target: string, signal?: AbortSignal): Promise<{url: string; title: string; text: string; links: {text: string; url: string}[]; untrusted: true}> {
    const approved = new URL(target);
    if (!['http:', 'https:'].includes(approved.protocol) || approved.username || approved.password) throw new Error('Browser inspection requires an HTTP(S) URL without credentials.');
    if (signal?.aborted) throw new Error('Browser inspection canceled.');
    const window = new BrowserWindow({show: false, webPreferences: {partition: `crux-inspect-${randomUUID()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false}});
    const session = window.webContents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on('will-download', event => event.preventDefault());
    session.webRequest.onBeforeRequest((details, callback) => {
      try { const url = new URL(details.url); callback({cancel: !['http:', 'https:'].includes(url.protocol) || url.origin !== approved.origin}); }
      catch { callback({cancel: true}); }
    });
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    const restrictNavigation = (event: Electron.Event, url: string) => {
      try { if (new URL(url).origin !== approved.origin) event.preventDefault(); } catch {event.preventDefault();}
    };
    window.webContents.on('will-navigate', restrictNavigation);
    window.webContents.on('will-redirect', restrictNavigation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { if (!window.isDestroyed()) window.destroy(); };
    signal?.addEventListener('abort', abort, {once: true});
    try {
      await Promise.race([window.loadURL(approved.href), new Promise<never>((_resolve, reject) => {timer = setTimeout(() => {abort(); reject(new Error('Web inspection timed out after 30 seconds.'));}, 30000);})]);
      if (signal?.aborted) throw new Error('Browser inspection canceled.');
      const data = await window.webContents.executeJavaScript(`(() => ({title: document.title.slice(0, 500), text: (document.body?.innerText || '').slice(0, 30000), links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({text: (a.innerText || '').slice(0, 200), url: a.href.slice(0, 2000)}))}))()`, false);
      return {url: window.webContents.getURL(), title: String(data.title), text: String(data.text), links: data.links, untrusted: true};
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!window.isDestroyed()) window.destroy();
      await session.clearStorageData().catch(() => undefined);
    }
  }
}
