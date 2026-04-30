import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  Tray,
  dialog,
  globalShortcut,
  nativeImage,
  screen,
  shell,
} from 'electron';
import type { NativeImage } from 'electron';
import path from 'path';
import log from 'electron-log';
import Store from 'electron-store';
import { registerIPCHandlers } from '../ipc/handlers.js';
import { AIService } from '../services/aiService.js';
import { FileService } from '../services/fileService.js';
import { TerminalService } from '../services/terminalService.js';

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

interface AppStoreSchema extends Record<string, unknown> {
  windowState: WindowState;
}

const store = new Store<AppStoreSchema>({
  defaults: {
    windowState: {
      width: 1500,
      height: 940,
      isMaximized: false,
    },
  },
});

const fileService = new FileService();
const terminalService = new TerminalService();
const aiService = new AIService(store);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const isDev = !app.isPackaged;

log.transports.file.level = 'info';
log.transports.console.level = isDev ? 'debug' : 'warn';

function getWindowState(): WindowState {
  return store.get('windowState');
}

function saveWindowState(): void {
  if (!mainWindow) {
    return;
  }

  const bounds = mainWindow.getBounds();
  store.set('windowState', {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: mainWindow.isMaximized(),
  });
}

function getFrontendEntry(): string {
  if (isDev) {
    return 'http://localhost:5173';
  }

  return path.join(app.getAppPath(), 'frontend', 'dist', 'index.html');
}

function getWindowIcon(): NativeImage {
  const possibleIcons = [
    path.join(app.getAppPath(), 'resources', 'icon.png'),
    path.join(process.resourcesPath, 'icon.png'),
  ];

  for (const iconPath of possibleIcons) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return nativeImage.createEmpty();
}

function createWindow(): void {
  const state = getWindowState();
  const workArea = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    x: state.x ?? Math.floor((workArea.width - state.width) / 2),
    y: state.y ?? Math.floor((workArea.height - state.height) / 2),
    width: state.width,
    height: state.height,
    minWidth: 1100,
    minHeight: 720,
    title: 'CruX',
    backgroundColor: '#06070b',
    show: false,
    icon: getWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }

    saveWindowState();
  });

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('unresponsive', () => {
    log.error('Renderer became unresponsive');
    new Notification({
      title: 'CruX needs attention',
      body: 'The renderer became unresponsive. Try reopening the window.',
    }).show();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process gone:', details);
    dialog.showMessageBox({
      type: 'error',
      title: 'CruX renderer crashed',
      message: 'CruX detected a renderer crash and protected your session.',
      detail: `${details.reason}`,
    }).catch(() => undefined);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch((error) => {
      log.error('Failed to open external URL:', error);
    });
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith('http://localhost:5173')) {
      return;
    }

    if (url.startsWith('file://')) {
      return;
    }

    event.preventDefault();
    shell.openExternal(url).catch((error) => {
      log.error('Failed to open navigation target:', error);
    });
  });

  registerIPCHandlers(ipcMain, {
    fileService,
    terminalService,
    aiService,
    store,
    mainWindow: () => mainWindow,
  });

  if (isDev) {
    mainWindow.loadURL(getFrontendEntry()).catch((error) => {
      log.error('Failed to load dev frontend:', error);
    });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(getFrontendEntry()).catch((error) => {
      log.error('Failed to load packaged frontend:', error);
    });
  }

  createMenu();
  createTray();
  registerShortcuts();
}

function createTray(): void {
  if (tray) {
    return;
  }

  tray = new Tray(getWindowIcon());
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show CruX',
      click: () => mainWindow?.show(),
    },
    {
      label: 'New Chat',
      click: () => mainWindow?.webContents.send('app:new-chat'),
    },
    { type: 'separator' },
    {
      label: 'Quit CruX',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('CruX');
  tray.setContextMenu(menu);
  tray.on('double-click', () => mainWindow?.show());
}

function createMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('app:new-chat'),
        },
        {
          label: 'Open Project',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
            if (!result.canceled && result.filePaths[0]) {
              store.set('workspace.currentProject', result.filePaths[0]);
              mainWindow?.webContents.send('project:opened', result.filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'CruX Docs',
          click: () => shell.openExternal('https://ollama.com').catch(() => undefined),
        },
        {
          label: 'About CruX',
          click: () => {
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About CruX',
              message: 'CruX',
              detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}\nNode ${process.versions.node}`,
            }).catch(() => undefined);
          },
        },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function installGlobalErrorHandling(): void {
  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception in main process:', error);
    dialog.showErrorBox('CruX main process error', error.message);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection in main process:', reason);
  });
}

app.whenReady().then(() => {
  installGlobalErrorHandling();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });
}).catch((error) => {
  log.error('Failed to initialize CruX:', error);
});

app.on('before-quit', () => {
  isQuitting = true;
  saveWindowState();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
