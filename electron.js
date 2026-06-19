'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { PROD_SERVER_URL } = require('./config');

let mainWindow  = null;
let prevBounds  = null;
let dragState   = null;
let splashWin   = null;

// ── Update window (shown during download) ───────────────────────
function createSplash(msg) {
  splashWin = new BrowserWindow({
    width: 340, height: 180,
    frame: false, transparent: true,
    alwaysOnTop: true, resizable: false,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  splashWin.loadURL(`data:text/html,
    <body style="margin:0;background:#0b0e11;display:flex;flex-direction:column;
      align-items:center;justify-content:center;height:100vh;
      font-family:sans-serif;color:#dbdee1;border-radius:12px">
      <div style="font-size:22px;font-weight:700;margin-bottom:12px">Звонок</div>
      <div id="msg" style="font-size:13px;color:#949ba4">${msg}</div>
      <div style="width:260px;height:4px;background:#1e1f22;border-radius:4px;margin-top:16px">
        <div id="bar" style="width:0%;height:100%;background:#5865f2;border-radius:4px;transition:width .3s"></div>
      </div>
      <script>
        const {ipcRenderer}=require('electron');
        ipcRenderer.on('upd-progress',(_,p)=>{
          document.getElementById('bar').style.width=p+'%';
          document.getElementById('msg').textContent='Скачиваю обновление: '+Math.round(p)+'%';
        });
        ipcRenderer.on('upd-msg',(_,m)=>{
          document.getElementById('msg').textContent=m;
        });
      </script>
    </body>`);
}

function setSplashMsg(msg) {
  splashWin?.webContents.send('upd-msg', msg);
}

function setSplashProgress(p) {
  splashWin?.webContents.send('upd-progress', p);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 600,
    minWidth: 0,
    minHeight: 0,
    resizable: false,
    frame: false,
    backgroundColor: '#0b0e11',
    show: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.webContents.session.setCertificateVerifyProc((_req, cb) => cb(0));

  mainWindow.webContents.on('will-navigate', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
  });

  mainWindow.webContents.on('did-navigate', (_e, url) => {
    prevBounds = null;
    dragState  = null;
    if (url.includes('/app')) {
      const { workArea } = screen.getPrimaryDisplay();
      const w = Math.round(workArea.width  * 0.90);
      const h = Math.round(workArea.height * 0.90);
      mainWindow.setResizable(true);
      mainWindow.setMinimumSize(960, 660);
      mainWindow.setSize(w, h);
      mainWindow.center();
    } else {
      mainWindow.setResizable(false);
      mainWindow.setMinimumSize(0, 0);
      mainWindow.setSize(480, 610);
      mainWindow.center();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) mainWindow.show();
  });

  if (!app.isPackaged) {
    // Dev: poll until local server is up
    let retries = 0;
    function load() {
      mainWindow.loadURL('https://localhost:3000').catch(() => {
        if (retries++ < 20) setTimeout(load, 500);
      });
    }
    setTimeout(load, 1500);

    mainWindow.webContents.on('did-fail-load', (_e, code) => {
      if (code === -6 && retries++ < 20) setTimeout(load, 500);
    });
  }

  mainWindow.on('closed', () => { mainWindow = null; prevBounds = null; dragState = null; });
}

// ── Window controls ──────────────────────────────────────────
ipcMain.on('win:minimize', () => mainWindow?.minimize());

ipcMain.on('win:maximize', () => {
  if (!mainWindow) return;
  if (prevBounds) {
    mainWindow.setBounds(prevBounds);
    prevBounds = null;
  } else {
    prevBounds = mainWindow.getBounds();
    const { workArea } = screen.getDisplayNearestPoint({ x: prevBounds.x, y: prevBounds.y });
    mainWindow.setBounds(workArea);
  }
});

ipcMain.on('win:close', () => mainWindow?.close());

// ── Custom titlebar drag with Discord-snap ───────────────────
ipcMain.on('win:drag-start', (_e, sx, sy) => {
  if (!mainWindow) return;
  let b = mainWindow.getBounds();

  if (prevBounds) {
    // Discord snap: restore size, position under cursor
    const restored = { ...prevBounds };
    prevBounds = null;
    const { workArea } = screen.getDisplayNearestPoint({ x: sx, y: sy });
    const relX = b.width > 0 ? (sx - b.x) / b.width : 0.5;
    const newX = Math.max(workArea.x, Math.min(
      workArea.x + workArea.width - restored.width,
      sx - Math.round(restored.width * relX)
    ));
    mainWindow.setBounds({ x: newX, y: Math.max(workArea.y, sy - 19),
                           width: restored.width, height: restored.height });
    b = mainWindow.getBounds();
  }

  dragState = { sx, sy, wx: b.x, wy: b.y, w: b.width, h: b.height };
});

ipcMain.on('win:drag-move', (_e, sx, sy) => {
  if (!dragState || !mainWindow) return;
  // setBounds (not setPosition) — явно фиксируем w/h, окно не может расшириться
  mainWindow.setBounds({
    x:      dragState.wx + (sx - dragState.sx),
    y:      dragState.wy + (sy - dragState.sy),
    width:  dragState.w,
    height: dragState.h,
  });
});

ipcMain.on('win:drag-end', () => { dragState = null; });

// ── Single instance ──────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (app.isPackaged) {
      // ── Production: connect to deployed server, check updates ──
      const { autoUpdater } = require('electron-updater');
      createSplash('Проверяю обновления…');

      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      let updateFound = false;

      autoUpdater.on('update-available', () => {
        updateFound = true;
        setSplashMsg('Нашёл обновление, скачиваю…');
      });

      autoUpdater.on('download-progress', ({ percent }) => {
        setSplashProgress(percent);
      });

      autoUpdater.on('update-downloaded', () => {
        setSplashMsg('Устанавливаю обновление…');
        setTimeout(() => autoUpdater.quitAndInstall(true, true), 1500);
      });

      autoUpdater.on('update-not-available', () => {
        launchMain();
      });

      autoUpdater.on('error', () => {
        // If update check fails, just launch normally
        launchMain();
      });

      try {
        await autoUpdater.checkForUpdates();
        // If no update found, update-not-available fires launchMain()
        // If update found, update-downloaded fires restart
      } catch {
        launchMain();
      }

      function launchMain() {
        if (splashWin && !splashWin.isDestroyed()) {
          splashWin.close();
          splashWin = null;
        }
        createWindow();
        mainWindow.loadURL(PROD_SERVER_URL);
      }

    } else {
      // ── Development: start local server ──────────────────────
      process.env.ZVONOK_DATA = path.join(app.getPath('userData'), 'data');
      require('./server.js');
      createWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
