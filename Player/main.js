// ─────────────────────────────────────────────────────────────────────────────
// main.js — Electron main process
// Netflix-style video player with:
//   • Frameless window + taskbar-safe bounds
//   • High-quality audio flags
//   • IPC for file dialog, window controls, fullscreen, track info
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// 1. SABSE PEHLE YE LINES HONI CHAHIYE (Imports)
const { app, BrowserWindow, ipcMain, dialog, Menu, screen } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs'); 
const os = require('os'); // Temp files ke liye zaroori hai

// FFmpeg aur FFprobe ke raste (Paths)
const FFMPEG_PATH  = path.join(__dirname, 'bin', 'ffmpeg.exe');
const FFPROBE_PATH = path.join(__dirname, 'bin', 'ffprobe.exe');

// 2. USKE BAAD HI APP KA KOI BHI CODE CHALEGA
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-accelerated-video-decode');

// ── High-quality audio & codec flags (must be BEFORE app.ready) ───────────────
app.commandLine.appendSwitch('enable-features', 'AudioServiceOutOfProcess,PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// Prefer higher-quality audio resampler
app.commandLine.appendSwitch('audio-buffer-size', '2048');


let mainWindow = null;

// ── Create Window ─────────────────────────────────────────────────────────────
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    // Start at the display's workArea so the window never overlaps the taskbar
    x:      workArea.x,
    y:      workArea.y,
    width:  workArea.width,
    height: workArea.height,

    minWidth:  900,
    minHeight: 540,

    frame:           false,      // Frameless — we draw our own title bar
    transparent:     false,
    backgroundColor: '#000000',

    // useContentSize: true tells Electron that width/height refer to the
    // *content* area, not the outer frame — critical for Windows DPI scaling
    useContentSize: true,

    // Taskbar icon ke liye path
    icon: path.join(__dirname, 'assets', 'icon.ico'),

    // Windows: respect workArea so maximise never covers the taskbar
    webPreferences: {
      nodeIntegration:    true,
      contextIsolation:   false,
      webSecurity:        false,   // needed for file:// video src
      backgroundThrottling: false, // don't throttle when window is hidden
    },

    show: false, // show only after ready-to-show to avoid white flash
  });

  // Remove default menu bar entirely
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // ── Taskbar-safe maximise ───────────────────────────────────────────────────
  mainWindow.on('maximize', () => {
    const { workArea: wa } = screen.getDisplayMatching(mainWindow.getBounds());
    mainWindow.setBounds(wa, false);
    mainWindow.webContents.send('window-maximized', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximized', false);
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('fullscreen-change', true);
  });

  mainWindow.on('leave-full-screen', () => {
    const { workArea: wa } = screen.getDisplayMatching(mainWindow.getBounds());
    mainWindow.setBounds(wa, false);
    mainWindow.webContents.send('fullscreen-change', false);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC: File dialog — now supports multiSelections for queue ─────────────────
ipcMain.handle('open-file-dialog', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Video File',
    filters: [
      {
        name: 'Video Files',
        extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'm4v', 'wmv', 'ts', 'ogv'],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
    // ← CHANGED: allow multiple file selection for the queue system
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  // Return array of paths; renderer handles single vs. multiple
  return result.filePaths;
});

// ── IPC: Window controls ──────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());

ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window-close', () => mainWindow?.close());

// ── IPC: Fullscreen ───────────────────────────────────────────────────────────
ipcMain.on('toggle-fullscreen', () => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ── IPC: File existence check (for intro asset guard) ────────────────────────
ipcMain.handle('file-exists', (_e, filePath) => {
  try { return fs.existsSync(filePath); } catch { return false; }
});


// ══════════════════════════════════════════════════════════════════════════════
// FFMPEG, SUBTITLES AUR NAYE FEATURES KA LOGIC (Yahan se start hota hai)
// Tera upar ka ek bhi line maine hataya nahi hai!
// ══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('open-subtitle-dialog', async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Subtitle File',
    filters: [
      { name: 'Subtitle Files', extensions: ['srt', 'vtt', 'ass', 'ssa'] },
      { name: 'All Files',      extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('read-file-text', (_e, filePath) => {
  try { return fs.readFileSync(filePath, 'utf8'); } catch (err) { throw new Error(err.message); }
});

ipcMain.handle('write-temp-file', (_e, filename, content) => {
  const tmpPath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(tmpPath, content, 'utf8');
  return tmpPath;
});

ipcMain.handle('ffprobe-tracks', (_e, filePath) => {
  return new Promise((resolve) => {
    if (!fs.existsSync(FFPROBE_PATH)) {
      return resolve({ audioTracks: [], subtitleTracks: [], error: 'ffprobe not found' });
    }
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'a:s', filePath];
    execFile(FFPROBE_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ audioTracks: [], subtitleTracks: [], error: err.message });
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        const audioTracks = streams.filter(s => s.codec_type === 'audio').map((s, i) => ({
          index: s.index, streamIndex: i, language: s.tags?.language || 'und', codec: s.codec_name || '', label: s.tags?.title || s.tags?.language || `Audio ${i + 1}`
        }));
        const subtitleTracks = streams.filter(s => s.codec_type === 'subtitle').map((s, i) => ({
          index: s.index, streamIndex: i, language: s.tags?.language || 'und', codec: s.codec_name || '', label: s.tags?.title || s.tags?.language || `Subtitle ${i + 1}`
        }));
        resolve({ audioTracks, subtitleTracks });
      } catch (e) {
        resolve({ audioTracks: [], subtitleTracks: [], error: 'Parse error' });
      }
    });
  });
});

ipcMain.handle('ffmpeg-extract-subtitle', (_e, filePath, streamIndex) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(FFMPEG_PATH)) return reject(new Error('ffmpeg not found'));
    const tmpFile = path.join(os.tmpdir(), `nplayer_sub_${Date.now()}_${streamIndex}.vtt`);
    const args = ['-y', '-i', filePath, '-map', `0:s:${streamIndex}`, '-f', 'webvtt', tmpFile];
    execFile(FFMPEG_PATH, args, { maxBuffer: 20 * 1024 * 1024 }, (err) => {
      if (err) reject(err); else resolve(tmpFile);
    });
  });
});

ipcMain.handle('ffmpeg-remux-audio', (_e, filePath, audioStreamIndex) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(FFMPEG_PATH)) return reject(new Error('ffmpeg not found'));
    const tmpFile = path.join(os.tmpdir(), `nplayer_audio_${Date.now()}_${audioStreamIndex}.mkv`);
    const args = ['-y', '-i', filePath, '-map', '0:v', '-map', `0:a:${audioStreamIndex}`, '-c', 'copy', '-avoid_negative_ts', 'make_zero', tmpFile];
    execFile(FFMPEG_PATH, args, { maxBuffer: 50 * 1024 * 1024 }, (err) => {
      if (err) reject(err); else resolve(tmpFile);
    });
  });
});

ipcMain.handle('cleanup-temp', (_e, filePaths) => {
  if (!Array.isArray(filePaths)) return;
  for (const fp of filePaths) {
    try { if (fp && fs.existsSync(fp) && fp.startsWith(os.tmpdir())) fs.unlinkSync(fp); } catch { }
  }
});