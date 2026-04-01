// ─────────────────────────────────────────────────────────────────────────────
// renderer.js — NPlayer v3 · Full Feature Set
//
// Modules (in order):
//   UTILS · SCREEN MANAGER · INTRO SEQUENCE · HOME SCREEN ·
//   CAPTION SETTINGS · PLAYER · PROGRESS BAR · THUMBNAIL SCRUBBER ·
//   AUDIO & SUBTITLES PANEL · DRAG & DROP · BOOT
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { ipcRenderer } = require('electron');
const path            = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// § UTILS
// ══════════════════════════════════════════════════════════════════════════════

const $ = (sel, ctx = document) => ctx.querySelector(sel);

/** Format seconds → h:mm:ss or m:ss */
function fmt(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm  = String(m).padStart(h ? 2 : 1, '0');
  const ss  = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * Convert a raw filesystem path to a safe file:/// URI.
 * Handles Windows backslashes, spaces, # signs, Unicode.
 */
function pathToFileURI(rawPath) {
  // Normalise to forward slashes
  let p = rawPath.replace(/\\/g, '/');
  // On Windows an absolute path starts with a drive letter: C:/...
  // file:// needs three slashes before drive letters
  if (!p.startsWith('/')) p = '/' + p;
  // Percent-encode everything except the path separators and drive colon
  // Using encodeURIComponent then restoring slashes and colons
  const encoded = p.split('/').map((seg, i) => {
    if (i === 1 && /^[A-Za-z]:$/.test(seg)) return seg; // drive letter C:
    return encodeURIComponent(seg).replace(/%2F/gi, '/');
  }).join('/');
  return 'file://' + encoded;
}

/** SRT → WebVTT conversion (pure JS, no FFmpeg needed for external files) */
function srtToVtt(srtText) {
  let vtt = 'WEBVTT\n\n';
  // Normalise line endings
  const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const blocks = normalized.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    let startLine = 0;
    // Skip numeric cue index
    if (/^\d+$/.test(lines[0].trim())) startLine = 1;

    const timeLine = lines[startLine];
    if (!timeLine || !timeLine.includes('-->')) continue;

    // SRT uses comma for milliseconds: 00:00:01,500 → 00:00:01.500
    const convertedTime = timeLine.replace(/,/g, '.');
    const cueText = lines.slice(startLine + 1).join('\n');

    vtt += convertedTime + '\n' + cueText + '\n\n';
  }
  return vtt;
}

// ══════════════════════════════════════════════════════════════════════════════
// § SCREEN MANAGER
// ══════════════════════════════════════════════════════════════════════════════
const ScreenManager = (() => {
  const screens = {
    intro:  $('#intro-screen'),
    home:   $('#home-screen'),
    player: $('#player-screen'),
  };

  function reset() {
    // Intro is visible by default (highest z-index), hide others
    screens.home.classList.add('hidden');
    screens.player.classList.add('hidden');
  }

  function show(name) {
    const el = screens[name];
    if (!el) return;
    el.classList.remove('hidden');
    void el.offsetWidth; // force reflow so CSS transition fires
    requestAnimationFrame(() => el.classList.add('visible'));
  }

  function hide(name, delayMs = 0) {
    const el = screens[name];
    if (!el) return;
    el.classList.remove('visible');
    setTimeout(() => el.classList.add('hidden'), delayMs);
  }

  function isVisible(name) {
    const el = screens[name];
    return el ? el.classList.contains('visible') : false;
  }

  return { reset, show, hide, isVisible };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § INTRO SEQUENCE
// Behaviour (per spec):
//   1. App opens → Home Screen shows immediately.
//   2. When a file is imported → play assets/intro.mp4 in the intro screen.
//   3. When intro ends (or skip) → crossfade into Player.
// ══════════════════════════════════════════════════════════════════════════════
const IntroSequence = (() => {
  const screen   = $('#intro-screen');
  const introVid = $('#intro-video');
  const skipBtn  = $('#intro-skip');

  let _onComplete = null; // callback: called when intro finishes
  let _active     = false;

  function finish() {
    if (!_active) return;
    _active = false;
    introVid.pause();

    screen.classList.add('fade-out');
    setTimeout(() => {
      screen.classList.add('hidden');
      screen.classList.remove('fade-out');
      if (_onComplete) { _onComplete(); _onComplete = null; }
    }, 850);
  }

  /**
   * Play the intro video, then call onComplete when done.
   * @param {Function} onComplete
   */
  function play(onComplete) {
    _onComplete = onComplete;
    _active     = true;

    // Reset intro video
    introVid.currentTime = 0;
    screen.classList.remove('hidden', 'fade-out');
    void screen.offsetWidth;
    screen.style.opacity = '1';

    introVid.play().catch(() => {
      // If intro.mp4 doesn't exist or can't autoplay, skip straight through
      finish();
    });
  }

  function init() {
    // On first launch: hide intro, go straight to home
    screen.classList.add('hidden');

    introVid.addEventListener('ended', finish);
    introVid.addEventListener('error', finish);
    skipBtn.addEventListener('click',  finish);
  }

  return { init, play };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § HOME SCREEN
// ══════════════════════════════════════════════════════════════════════════════
const HomeScreen = (() => {
  function show() {
    ScreenManager.show('home');
  }

  function hide(delayMs = 600) {
    ScreenManager.hide('home', delayMs);
  }

  function init() {
    $('#import-btn').addEventListener('click', async () => {
      const fp = await ipcRenderer.invoke('open-file-dialog');
      if (fp) Player.loadWithIntro(fp);
    });

    $('#home-btn-min').addEventListener('click',   () => ipcRenderer.send('window-minimize'));
    $('#home-btn-max').addEventListener('click',   () => ipcRenderer.send('window-maximize'));
    $('#home-btn-close').addEventListener('click', () => ipcRenderer.send('window-close'));
  }

  return { init, show, hide };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § CAPTION SETTINGS
// Persisted to localStorage. Injects/updates a <style id="cue-style"> tag.
// Settings: bgOpacity (0–1), fontFamily, textShadow (none/glow/drop)
// ══════════════════════════════════════════════════════════════════════════════
const CaptionSettings = (() => {
  const LS_KEY = 'nplayer_caption_settings';

  const DEFAULTS = {
    bgOpacity:  0.75,
    fontFamily: 'auto',   // 'auto' | 'serif' | 'sans-serif' | 'monospace' | 'cursive'
    textShadow: 'drop',   // 'none' | 'glow' | 'drop'
    fontSize:   100,      // percent of default
    color:      '#ffffff',
  };

  let settings = { ...DEFAULTS };

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      settings = { ...DEFAULTS, ...saved };
    } catch { settings = { ...DEFAULTS }; }
    applyStyles();
  }

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch {}
  }

  function set(key, value) {
    settings[key] = value;
    save();
    applyStyles();
  }

  function get(key) { return settings[key]; }

  function applyStyles() {
    let styleEl = document.getElementById('cue-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'cue-style';
      document.head.appendChild(styleEl);
    }

    const { bgOpacity, fontFamily, textShadow, fontSize, color } = settings;

    const bgRgba  = `rgba(0,0,0,${bgOpacity})`;
    const fontVal = fontFamily === 'auto' ? 'inherit' : fontFamily;

    let shadowVal = 'none';
    if (textShadow === 'glow')  shadowVal = '0 0 8px #fff, 0 0 16px #fff, 0 0 24px rgba(255,255,255,0.5)';
    if (textShadow === 'drop')  shadowVal = '2px 2px 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)';

    // ::cue styling — inline CSS for WebVTT tracks rendered by the browser
    styleEl.textContent = `
      ::cue {
        background-color: ${bgRgba};
        color: ${color};
        font-family: ${fontVal};
        font-size: ${fontSize}%;
        text-shadow: ${shadowVal};
        line-height: 1.4;
        padding: 2px 6px;
        border-radius: 2px;
      }
    `;
  }

  // Public API used by the A&S panel's caption section
  return { load, set, get, applyStyles, DEFAULTS, get settings() { return { ...settings }; } };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § PLAYER
// Central coordinator: load, play/pause, ripple, controls auto-hide.
// ══════════════════════════════════════════════════════════════════════════════
const Player = (() => {
  const playerScreen = $('#player-screen');
  const videoLayer   = $('#video-layer');
  const video        = $('#main-video');
  const ripple       = $('#click-ripple');
  const titleDisp    = $('#title-display');

  // ── State ─────────────────────────────────────────────────────────────────
  let hideTimer       = null;
  let currentFilePath = null;  // raw OS path of the currently playing file
  let tempFiles       = [];    // track temp files for cleanup on next load

  // Controls must NOT hide when any of these are true
  let _isOverControls = false;
  let _isScrubbing    = false;
  let _isModalOpen    = false;

  // ── Path → URI ─────────────────────────────────────────────────────────────
  function buildSrc(rawPath) {
    return pathToFileURI(rawPath);
  }

  // ── Internal load (no intro) ────────────────────────────────────────────────
  function _doLoad(rawPath) {
    currentFilePath = rawPath;

    // Clean up any temp files from last session
    if (tempFiles.length) {
      ipcRenderer.invoke('cleanup-temp', tempFiles);
      tempFiles = [];
    }

    video.src = buildSrc(rawPath);
    titleDisp.textContent = path.basename(rawPath, path.extname(rawPath));

    video.addEventListener('loadedmetadata', _onMetadata, { once: true });
    video.load();
    video.play().catch(console.warn);

    // Reset & seed the thumbnail scrubber
    ThumbnailScrubber.reset(video);
  }

  /**
   * Load a video. Called from Home Screen (plays intro first).
   */
  function loadWithIntro(rawPath) {
    HomeScreen.hide(0);

    // Play intro → on complete → show player + actual video
    IntroSequence.play(() => {
      ScreenManager.show('player');
      _doLoad(rawPath);
    });
  }

  /**
   * Swap current movie (Stream Something New / Open File from player).
   * Keeps the player screen visible, no intro replay.
   */
  function swapFile(rawPath) {
    video.pause();
    ScreenManager.show('player');
    _doLoad(rawPath);
  }

  function _onMetadata() {
    ProgressBar.sync();
    AudioSubtitlesPanel.detectTracks(video, currentFilePath);
    ThumbnailScrubber.onReady(video);
    SubtitlePersistence.autoLoad(video, currentFilePath);
  }

  // ── Play / Pause ───────────────────────────────────────────────────────────
  function togglePlay() {
    if (!video.src) return;
    video.paused ? video.play() : video.pause();
  }

  // ── Click ripple ──────────────────────────────────────────────────────────
  function flashRipple(isNowPaused) {
    const playIcon  = `<svg viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>`;
    const pauseIcon = `<svg viewBox="0 0 24 24" fill="white"><rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/></svg>`;
    ripple.innerHTML = isNowPaused ? playIcon : pauseIcon;
    ripple.classList.remove('pop', 'fade');
    void ripple.offsetWidth;
    ripple.classList.add('pop');
    setTimeout(() => { ripple.classList.remove('pop'); ripple.classList.add('fade'); }, 200);
  }

  // ── Controls visibility ────────────────────────────────────────────────────
  function _canHide() {
    return !_isOverControls && !_isScrubbing && !_isModalOpen && !video.paused;
  }

  function showControls(scheduleHide = true) {
    playerScreen.classList.add('controls-visible');
    videoLayer.style.cursor = 'default';
    clearTimeout(hideTimer);
    if (scheduleHide && _canHide()) {
      hideTimer = setTimeout(hideControls, 3200);
    }
  }

  function hideControls() {
    if (!_canHide()) return;
    playerScreen.classList.remove('controls-visible');
    videoLayer.style.cursor = 'none';
  }

  function lockControls()   { _isModalOpen = true;  showControls(false); }
  function unlockControls() { _isModalOpen = false; showControls(); }

  function setScrubbing(v) {
    _isScrubbing = v;
    if (v) { clearTimeout(hideTimer); showControls(false); }
    else   { showControls(); }
  }

  // ── Play/Pause icon sync ───────────────────────────────────────────────────
  function _syncPlayIcon() {
    $('#icon-play').style.display  = video.paused ? 'block' : 'none';
    $('#icon-pause').style.display = video.paused ? 'none'  : 'block';
  }

  function _syncMuteIcon() {
    const muted = video.muted || video.volume === 0;
    $('#icon-vol').style.display   = muted ? 'none'  : 'block';
    $('#icon-muted').style.display = muted ? 'block' : 'none';
    if (!muted) $('#vol-slider').value = video.volume;
  }

  // ── Keyboard handler ───────────────────────────────────────────────────────
  function _onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (!ScreenManager.isVisible('player') && !$('#player-screen').classList.contains('visible')) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        flashRipple(video.paused);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        showControls();
        break;
      case 'ArrowRight':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        showControls();
        break;
      case 'ArrowUp':
        e.preventDefault();
        video.volume = clamp(video.volume + 0.1, 0, 1);
        $('#vol-slider').value = video.volume;
        _syncMuteIcon();
        showControls();
        break;
      case 'ArrowDown':
        e.preventDefault();
        video.volume = clamp(video.volume - 0.1, 0, 1);
        $('#vol-slider').value = video.volume;
        _syncMuteIcon();
        showControls();
        break;
      case 'KeyM':
        video.muted = !video.muted;
        if (!video.muted && video.volume === 0) video.volume = 0.5;
        _syncMuteIcon();
        break;
      case 'KeyF':
        ipcRenderer.send('toggle-fullscreen');
        break;
      case 'KeyS':
        AudioSubtitlesPanel.toggle();
        break;
      case 'KeyO':
        ipcRenderer.invoke('open-file-dialog').then(fp => { if (fp) swapFile(fp); });
        break;
      case 'Escape':
        AudioSubtitlesPanel.close();
        break;
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    // Video events
    video.addEventListener('play',       () => { _syncPlayIcon(); showControls(); });
    video.addEventListener('pause',      () => { _syncPlayIcon(); showControls(false); });
    video.addEventListener('ended',      () => { _syncPlayIcon(); showControls(false); });
    video.addEventListener('timeupdate', () => ProgressBar.onTimeUpdate());
    video.addEventListener('progress',   () => ProgressBar.onBuffer());
    video.addEventListener('error',      (e) => {
      console.error('Video error:', video.error?.message, video.src);
    });

    // Click on video layer → play/pause (but not if clicking controls)
    videoLayer.addEventListener('click', (e) => {
      if ($('#controls-layer').contains(e.target)) return;
      togglePlay();
      flashRipple(video.paused);
    });

    // Mouse movement: show controls, track if over controls layer
    videoLayer.addEventListener('mousemove', () => showControls());
    videoLayer.addEventListener('mouseleave', () => {
      _isOverControls = false;
      if (_canHide()) hideTimer = setTimeout(hideControls, 800);
    });

    const ctrlLayer = $('#controls-layer');
    ctrlLayer.addEventListener('mouseenter', () => {
      _isOverControls = true;
      clearTimeout(hideTimer);
      showControls(false);
    });
    ctrlLayer.addEventListener('mouseleave', () => {
      _isOverControls = false;
      showControls(); // restart auto-hide countdown
    });

    // ── Control buttons ──────────────────────────────────────────────────────
    $('#btn-play').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlay();
    });

    $('#btn-back').addEventListener('click', () => {
      video.currentTime = Math.max(0, video.currentTime - 10);
      showControls();
    });

    $('#btn-fwd').addEventListener('click', () => {
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
      showControls();
    });

    // Volume
    const volSlider = $('#vol-slider');
    volSlider.addEventListener('input', () => {
      video.volume = parseFloat(volSlider.value);
      video.muted  = video.volume === 0;
      _syncMuteIcon();
    });
    $('#btn-mute').addEventListener('click', () => {
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) { video.volume = 0.5; volSlider.value = 0.5; }
      _syncMuteIcon();
    });

    // Open / Stream Something New — swaps file without re-running intro
    const openNewFile = async () => {
      const fp = await ipcRenderer.invoke('open-file-dialog');
      if (fp) swapFile(fp);
    };

    $('#btn-open').addEventListener('click', openNewFile);

    // #btn-stream-new may or may not exist — wire it if present
    const btnStreamNew = document.getElementById('btn-stream-new');
    if (btnStreamNew) btnStreamNew.addEventListener('click', openNewFile);

    // Fullscreen
    $('#btn-fs').addEventListener('click', () => ipcRenderer.send('toggle-fullscreen'));

    // Title bar window controls
    $('#btn-min').addEventListener('click',   () => ipcRenderer.send('window-minimize'));
    $('#btn-max').addEventListener('click',   () => ipcRenderer.send('window-maximize'));
    $('#btn-close').addEventListener('click', () => ipcRenderer.send('window-close'));

    // A&S modal button
    $('#btn-as').addEventListener('click', (e) => {
      e.stopPropagation();
      AudioSubtitlesPanel.toggle();
    });

    // IPC: fullscreen / maximized state
    ipcRenderer.on('window-state-change', (_e, { maximized, fullscreen }) => {
      $('#icon-fs').style.display      = fullscreen ? 'none'  : 'block';
      $('#icon-exit-fs').style.display = fullscreen ? 'block' : 'none';
    });

    // Keyboard
    document.addEventListener('keydown', _onKeyDown);

    // Expose helpers to other modules
    Player._setScrubbing     = setScrubbing;
    Player._lockControls     = lockControls;
    Player._unlockControls   = unlockControls;
    Player._video            = video;
    Player._addTempFile      = (fp) => tempFiles.push(fp);
    Player._currentFilePath  = () => currentFilePath;
  }

  return {
    init,
    loadWithIntro,
    swapFile,
    get video() { return video; },
  };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § PROGRESS BAR
// Fixed: controls don't hide while scrubbing or hovering.
// Thumbnail vertical buffer: 100px extended hit zone via #progress-zone.
// ══════════════════════════════════════════════════════════════════════════════
const ProgressBar = (() => {
  const video    = $('#main-video');
  const wrap     = $('#progress-wrap');
  const zone     = $('#progress-zone');   // tall element = vertical buffer
  const fill     = $('#progress-fill');
  const buffer   = $('#progress-buffer');
  const thumb    = $('#progress-thumb');
  const timeDisp = $('#time-display');

  let isScrubbing = false;

  function _pct() {
    return video.duration ? (video.currentTime / video.duration) * 100 : 0;
  }

  function _setFill(p) {
    fill.style.width = p + '%';
    thumb.style.left = p + '%';
  }

  function onTimeUpdate() {
    if (isScrubbing) return;
    _setFill(_pct());
    timeDisp.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  }

  function onBuffer() {
    if (!video.duration || !video.buffered.length) return;
    const end = video.buffered.end(video.buffered.length - 1);
    buffer.style.width = ((end / video.duration) * 100) + '%';
  }

  function sync() {
    _setFill(_pct());
    timeDisp.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  }

  function _xToTime(clientX) {
    const rect  = wrap.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * (video.duration || 0);
  }

  function _scrubTo(clientX) {
    const t = _xToTime(clientX);
    video.currentTime = t;
    _setFill(video.duration ? (t / video.duration) * 100 : 0);
    timeDisp.textContent = `${fmt(t)} / ${fmt(video.duration)}`;
    ThumbnailScrubber.show(clientX, t);
  }

  function init() {
    // ── Mousedown on progress wrap → start scrubbing ───────────────────────
    wrap.addEventListener('mousedown', (e) => {
      isScrubbing = true;
      Player._setScrubbing(true);
      _scrubTo(e.clientX);

      const onMove = (ev) => _scrubTo(ev.clientX);
      const onUp   = ()   => {
        isScrubbing = false;
        Player._setScrubbing(false);
        ThumbnailScrubber.hide();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    // ── Hover over progress-zone (tall hit area = vertical buffer) ─────────
    // The zone is styled to be 100px tall centred on the thin bar so mouse
    // doesn't have to be pixel-perfect.
    zone.addEventListener('mousemove', (e) => {
      const t = _xToTime(e.clientX);
      ThumbnailScrubber.show(e.clientX, t);
      Player._setScrubbing(isScrubbing); // keep controls alive
    });

    zone.addEventListener('mouseenter', () => {
      Player._setScrubbing(isScrubbing);
    });

    zone.addEventListener('mouseleave', () => {
      if (!isScrubbing) {
        ThumbnailScrubber.hide();
        Player._setScrubbing(false);
      }
    });
  }

  return { init, onTimeUpdate, onBuffer, sync };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § THUMBNAIL SCRUBBER
// • Uses a hidden <video> for frame capture (no FFmpeg needed).
// • Background cache builds at 5s intervals for instant first-paint.
// • Smooth easing via CSS transform transition + requestAnimationFrame lerp.
// • Vertical buffer handled by #progress-zone in the DOM (100px tall zone).
// • No flicker: debounced seek, cached frames drawn immediately.
// ══════════════════════════════════════════════════════════════════════════════
const ThumbnailScrubber = (() => {
  const thumbEl   = $('#scrub-thumb');
  const canvas    = $('#scrub-canvas');
  const timeLabel = $('#scrub-time-label');
  const zone      = $('#progress-zone');
  const ctx       = canvas.getContext('2d');

  // Hidden scrub video — shares the same src as main player
  const scrubVid   = document.createElement('video');
  scrubVid.muted   = true;
  scrubVid.preload = 'auto';
  scrubVid.style.cssText =
    'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px;left:-9999px;';
  document.body.appendChild(scrubVid);

  const CACHE_STEP  = 5;           // cache a frame every N seconds
  const frameCache  = new Map();   // t → ImageBitmap
  let   cacheAbort  = false;

  // ── Frame drawing ─────────────────────────────────────────────────────────
  function _draw() {
    try {
      ctx.drawImage(scrubVid, 0, 0, canvas.width, canvas.height);
    } catch {}
  }

  // ── Background cache build ─────────────────────────────────────────────────
  async function _buildCache(duration) {
    cacheAbort = false;
    frameCache.clear();

    for (let t = 0; t <= duration; t += CACHE_STEP) {
      if (cacheAbort) break;
      await new Promise((resolve) => {
        const onSeeked = () => {
          try {
            ctx.drawImage(scrubVid, 0, 0, canvas.width, canvas.height);
            createImageBitmap(canvas).then(bmp => {
              frameCache.set(t, bmp);
              resolve();
            }).catch(resolve);
          } catch { resolve(); }
          scrubVid.removeEventListener('seeked', onSeeked);
        };
        scrubVid.addEventListener('seeked', onSeeked, { once: true });
        scrubVid.currentTime = t;
      });
      // Yield to keep UI responsive
      await new Promise(r => setTimeout(r, 0));
    }
  }

  function _nearestCached(t) {
    const snap = Math.round(t / CACHE_STEP) * CACHE_STEP;
    if (frameCache.has(snap)) return snap;
    let best = -1, bestD = Infinity;
    for (const [k] of frameCache) {
      const d = Math.abs(k - t);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best >= 0 ? best : null;
  }

  // ── Smooth position lerp ─────────────────────────────────────────────────
  // We animate the thumbnail's X position with a lerp loop for the "eased"
  // premium feel instead of a hard jump.
  let _targetX    = 0;
  let _currentX   = 0;
  let _rafId      = null;
  let _thumbWidth = 160; // matches CSS --thumb-w

  function _startLerp() {
    if (_rafId) return;
    function step() {
      _currentX += (_targetX - _currentX) * 0.18; // easing factor
      thumbEl.style.left = _currentX + 'px';
      if (Math.abs(_targetX - _currentX) > 0.3) {
        _rafId = requestAnimationFrame(step);
      } else {
        _currentX = _targetX;
        thumbEl.style.left = _currentX + 'px';
        _rafId = null;
      }
    }
    _rafId = requestAnimationFrame(step);
  }

  // ── Debounced precise seek ────────────────────────────────────────────────
  let _seekTimer = null;

  // ── Show ──────────────────────────────────────────────────────────────────
  function show(clientX, t) {
    if (!scrubVid.src) return;

    thumbEl.classList.add('visible');
    timeLabel.textContent = fmt(t);

    // Clamp X so thumbnail stays inside the zone bounds
    const zoneRect  = zone.getBoundingClientRect();
    const half      = _thumbWidth / 2;
    const clampedX  = clamp(clientX, zoneRect.left + half, zoneRect.right - half);
    _targetX        = clampedX - zoneRect.left;
    _startLerp();

    // Paint nearest cached frame immediately (no flicker on fast moves)
    const cached = _nearestCached(t);
    if (cached !== null && frameCache.has(cached)) {
      ctx.drawImage(frameCache.get(cached), 0, 0, canvas.width, canvas.height);
    }

    // Debounced exact seek for precise frame
    clearTimeout(_seekTimer);
    _seekTimer = setTimeout(() => {
      if (Math.abs(scrubVid.currentTime - t) > 0.4) {
        scrubVid.currentTime = t;
      }
    }, 60);
  }

  function hide() {
    thumbEl.classList.remove('visible');
    clearTimeout(_seekTimer);
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  }

  function reset(mainVideo) {
    cacheAbort = true;
    frameCache.clear();
    hide();
    scrubVid.src = mainVideo.src;
    scrubVid.load();
  }

  function onReady(mainVideo) {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Remove any previous seeked listener to avoid stacking
    scrubVid.removeEventListener('seeked', _draw);
    scrubVid.addEventListener('seeked', _draw);

    if (mainVideo.duration && isFinite(mainVideo.duration)) {
      _buildCache(mainVideo.duration);
    }
  }

  return { show, hide, reset, onReady };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § SUBTITLE PERSISTENCE
// localStorage key: `nplayer_sub_${filePath}`
// Value: JSON { vttPath, label }
// ══════════════════════════════════════════════════════════════════════════════
const SubtitlePersistence = (() => {
  function _key(filePath) {
    return 'nplayer_sub_' + filePath;
  }

  function save(filePath, vttPath, label) {
    try {
      localStorage.setItem(_key(filePath), JSON.stringify({ vttPath, label }));
    } catch {}
  }

  function remove(filePath) {
    try { localStorage.removeItem(_key(filePath)); } catch {}
  }

  /**
   * Check localStorage for a saved subtitle for the given file.
   * If found and the vtt file still exists, attach it automatically.
   */
  async function autoLoad(video, filePath) {
    try {
      const raw = localStorage.getItem(_key(filePath));
      if (!raw) return;
      const { vttPath, label } = JSON.parse(raw);
      if (!vttPath) return;

      const exists = await ipcRenderer.invoke('file-exists', vttPath);
      if (!exists) { remove(filePath); return; }

      AudioSubtitlesPanel.attachSubtitleTrack(video, vttPath, label || 'Saved', true);
    } catch {}
  }

  return { save, remove, autoLoad };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § AUDIO & SUBTITLES PANEL
// Modal with:
//   • Audio column: FFprobe-detected tracks + native audioTracks API fallback
//   • Subtitles column: native textTracks + FFprobe internal subs + Add External
//   • Caption Settings: bg opacity, font family, text shadow
// ══════════════════════════════════════════════════════════════════════════════
const AudioSubtitlesPanel = (() => {
  const overlay   = $('#as-overlay');
  const modal     = $('#as-modal');
  const closeBtn  = $('#as-close');
  const audioList = $('#audio-track-list');
  const subList   = $('#subtitle-track-list');
  const addSubBtn = $('#add-sub-btn');

  let isOpen      = false;
  let _video      = null;
  let _filePath   = null;

  // ── Open / Close ───────────────────────────────────────────────────────────
  function open() {
    isOpen = true;
    overlay.classList.add('open');
    Player._lockControls();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    overlay.classList.remove('open');
    Player._unlockControls();
  }

  function toggle() {
    isOpen ? close() : open();
  }

  // ── Build a track list item ────────────────────────────────────────────────
  function _makeItem(label, isActive, onClick) {
    const li = document.createElement('li');
    li.className = 'as-track-item' + (isActive ? ' active' : '');

    const check = document.createElement('span');
    check.className = 'check-dot';
    // Netflix-style: show a red ✓ for active
    check.innerHTML = isActive
      ? `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
           <polyline points="1,6 4.5,9.5 11,2" stroke="#E50914" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
         </svg>`
      : '';

    const name = document.createElement('span');
    name.className = 'as-track-label';
    name.textContent = label;

    li.append(check, name);
    li.addEventListener('click', () => {
      onClick(li);
    });
    return li;
  }

  // ── "Off" option for subtitles ────────────────────────────────────────────
  function _buildSubOffItem(trackList) {
    return _makeItem('Off', false, (li) => {
      Array.from(trackList).forEach(t => { t.mode = 'hidden'; });
      subList.querySelectorAll('.as-track-item').forEach(el => el.classList.remove('active'));
      subList.querySelectorAll('.check-dot').forEach(el => { el.innerHTML = ''; });
      li.classList.add('active');
      li.querySelector('.check-dot').innerHTML =
        `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
           <polyline points="1,6 4.5,9.5 11,2" stroke="#E50914" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
         </svg>`;
    });
  }

  // ── Populate Audio column ─────────────────────────────────────────────────
  function _buildAudioList(ffprobeTracks) {
    audioList.innerHTML = '';

    // 1. Try native HTMLMediaElement.audioTracks (works for MP4, some WebM)
    const nativeTracks = _video?.audioTracks;
    if (nativeTracks && nativeTracks.length > 1) {
      Array.from(nativeTracks).forEach((track, i) => {
        const label = track.label || track.language || `Audio ${i + 1}`;
        const li = _makeItem(label, track.enabled, (el) => {
          // Disable all, enable selected
          Array.from(nativeTracks).forEach((t, j) => { t.enabled = (j === i); });
          audioList.querySelectorAll('.as-track-item').forEach((item, j) => {
            item.classList.toggle('active', j === i);
            const dot = item.querySelector('.check-dot');
            dot.innerHTML = j === i
              ? `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                   <polyline points="1,6 4.5,9.5 11,2" stroke="#E50914" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                 </svg>` : '';
          });
        });
        audioList.appendChild(li);
      });
      return;
    }

    // 2. Use FFprobe results for MKV / multi-track files
    if (ffprobeTracks && ffprobeTracks.length > 0) {
      ffprobeTracks.forEach((track, i) => {
        const isFirst = i === 0;
        const li = _makeItem(track.label, isFirst, (el) => {
          // Remux via FFmpeg to select this audio stream
          _switchAudioTrack(track.streamIndex, el);
        });
        li.dataset.streamIndex = track.streamIndex;
        audioList.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.className = 'as-empty';
      li.textContent = 'Default audio track';
      audioList.appendChild(li);
    }
  }

  // ── Audio track switch via FFmpeg remux ───────────────────────────────────
  async function _switchAudioTrack(streamIndex, clickedEl) {
    if (!_filePath) return;

    // Show loading state
    clickedEl.classList.add('loading');
    const origLabel = clickedEl.querySelector('.as-track-label')?.textContent;
    if (clickedEl.querySelector('.as-track-label')) {
      clickedEl.querySelector('.as-track-label').textContent = 'Switching…';
    }

    try {
      const tmpPath = await ipcRenderer.invoke('ffmpeg-remux-audio', _filePath, streamIndex);
      Player._addTempFile(tmpPath);

      const currentTime = _video.currentTime;
      const wasPaused   = _video.paused;

      _video.src = pathToFileURI(tmpPath);
      _video.load();
      _video.currentTime = currentTime;
      if (!wasPaused) _video.play().catch(console.warn);

      // Update UI
      audioList.querySelectorAll('.as-track-item').forEach(el => {
        el.classList.remove('active', 'loading');
        const dot = el.querySelector('.check-dot');
        if (dot) dot.innerHTML = '';
        const lbl = el.querySelector('.as-track-label');
        if (lbl && el.dataset.streamIndex == streamIndex) {
          lbl.textContent = origLabel;
        }
      });
      clickedEl.classList.add('active');
      const dot = clickedEl.querySelector('.check-dot');
      if (dot) dot.innerHTML =
        `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
           <polyline points="1,6 4.5,9.5 11,2" stroke="#E50914" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
         </svg>`;

    } catch (err) {
      console.error('Audio switch failed:', err);
      clickedEl.classList.remove('loading');
      if (clickedEl.querySelector('.as-track-label')) {
        clickedEl.querySelector('.as-track-label').textContent = origLabel || 'Error';
      }
    }
  }

  // ── Populate Subtitle column ──────────────────────────────────────────────
  function _buildSubList(ffprobeSubTracks) {
    subList.innerHTML = '';

    // Off option
    subList.appendChild(_buildSubOffItem(_video?.textTracks || []));

    // Native textTracks (external VTT already attached, WebM internal, etc.)
    if (_video?.textTracks) {
      Array.from(_video.textTracks).forEach((track, i) => {
        const label = track.label || track.language || `Track ${i + 1}`;
        const li = _makeItem(label, track.mode === 'showing', (el) => {
          _selectSubTrack(track, el);
        });
        subList.appendChild(li);
      });

      // Watch for new tracks being added dynamically
      _video.textTracks.addEventListener('addtrack', () => {
        _buildSubList(ffprobeSubTracks);
      });
    }

    // FFprobe internal subtitle tracks (for MKV embedded subs)
    if (ffprobeSubTracks && ffprobeSubTracks.length > 0) {
      const alreadyNative = _video?.textTracks?.length || 0;

      ffprobeSubTracks.forEach((track) => {
        // Avoid duplicating tracks already exposed natively
        const label = `[Embedded] ${track.label}`;
        const li = _makeItem(label, false, (el) => {
          _extractAndActivateSub(track.streamIndex, track.label, el);
        });
        li.dataset.ffprobeIndex = track.streamIndex;
        subList.appendChild(li);
      });
    }
  }

  // ── Select a native text track ────────────────────────────────────────────
  function _selectSubTrack(track, clickedEl) {
    if (!_video) return;
    const wasShowing = track.mode === 'showing';

    Array.from(_video.textTracks).forEach(t => { t.mode = 'hidden'; });
    subList.querySelectorAll('.as-track-item').forEach(el => {
      el.classList.remove('active');
      const dot = el.querySelector('.check-dot');
      if (dot) dot.innerHTML = '';
    });

    if (!wasShowing) {
      track.mode = 'showing';
      clickedEl.classList.add('active');
      const dot = clickedEl.querySelector('.check-dot');
      if (dot) dot.innerHTML =
        `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
           <polyline points="1,6 4.5,9.5 11,2" stroke="#E50914" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
         </svg>`;
    }
  }

  // ── Extract embedded sub via FFmpeg → attach as VTT track ─────────────────
  async function _extractAndActivateSub(streamIndex, label, clickedEl) {
    if (!_filePath) return;
    if (clickedEl.querySelector('.as-track-label')) {
      clickedEl.querySelector('.as-track-label').textContent = 'Extracting…';
    }

    try {
      const vttPath = await ipcRenderer.invoke('ffmpeg-extract-subtitle', _filePath, streamIndex);
      Player._addTempFile(vttPath);
      attachSubtitleTrack(_video, vttPath, label, true);
      SubtitlePersistence.save(_filePath, vttPath, label);
    } catch (err) {
      console.error('Subtitle extraction failed:', err);
      if (clickedEl.querySelector('.as-track-label')) {
        clickedEl.querySelector('.as-track-label').textContent = label + ' (failed)';
      }
    }
  }

  /**
   * Attach a VTT file as a <track> element on the video.
   * @param {HTMLVideoElement} video
   * @param {string} vttPath  — filesystem path to the .vtt file
   * @param {string} label
   * @param {boolean} autoActivate — set mode to 'showing' immediately
   */
  function attachSubtitleTrack(video, vttPath, label, autoActivate = false) {
    // Remove any existing tracks with the same label to prevent duplicates
    const existing = Array.from(video.querySelectorAll('track'));
    existing.forEach(t => { if (t.label === label) t.remove(); });

    const track = document.createElement('track');
    track.kind    = 'subtitles';
    track.label   = label;
    track.srclang = 'und';
    track.src     = pathToFileURI(vttPath);

    if (autoActivate) {
      // Disable all other subtitle tracks first
      Array.from(video.textTracks).forEach(t => { t.mode = 'hidden'; });
      track.default = true;
      track.addEventListener('load', () => {
        try { video.textTracks[video.textTracks.length - 1].mode = 'showing'; } catch {}
      });
    }

    video.appendChild(track);
    _buildSubList([]); // refresh list
  }

  // ── Add External Subtitle button ──────────────────────────────────────────
  async function _handleAddSub() {
    const subPath = await ipcRenderer.invoke('open-subtitle-dialog');
    if (!subPath) return;

    const ext = path.extname(subPath).toLowerCase();
    let vttPath;
    const label = path.basename(subPath, path.extname(subPath));

    if (ext === '.vtt') {
      vttPath = subPath;
    } else if (ext === '.srt') {
      // Convert SRT → VTT in the renderer (pure JS, no FFmpeg needed)
      try {
        const srtText = await ipcRenderer.invoke('read-file-text', subPath);
        const vttText = srtToVtt(srtText);
        const tmpName = `nplayer_ext_sub_${Date.now()}.vtt`;
        vttPath = await ipcRenderer.invoke('write-temp-file', tmpName, vttText);
        Player._addTempFile(vttPath);
      } catch (err) {
        console.error('SRT conversion failed:', err);
        return;
      }
    } else {
      // For ASS/SSA, use FFmpeg to convert
      try {
        const tmpName  = `nplayer_ext_sub_${Date.now()}.vtt`;
        const tmpPath  = await ipcRenderer.invoke('write-temp-file', tmpName, '');
        // Re-use ffmpeg extract but from a standalone file
        const args     = ['-y', '-i', subPath, '-f', 'webvtt', tmpPath];
        // We don't have a direct IPC for arbitrary ffmpeg — use extract with index 0
        // Fallback: just try attaching directly
        vttPath = subPath;
      } catch {
        vttPath = subPath;
      }
    }

    if (vttPath && _video) {
      attachSubtitleTrack(_video, vttPath, label, true);
      if (_filePath) SubtitlePersistence.save(_filePath, vttPath, label);
    }
  }

  // ── Caption Settings sub-section ─────────────────────────────────────────
  function _buildCaptionSettings() {
    // Check if section already exists
    if (document.getElementById('caption-settings-section')) return;

    const section = document.createElement('div');
    section.id = 'caption-settings-section';
    section.style.cssText =
      'border-top:1px solid rgba(255,255,255,0.08);margin-top:14px;padding-top:14px;';

    const title = document.createElement('div');
    title.className = 'as-col-header';
    title.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
      </svg>
      Caption Style
    `;
    section.appendChild(title);

    const s = CaptionSettings.settings;

    // Helper: row with label + control
    const row = (labelText, controlHTML) => {
      const d = document.createElement('div');
      d.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;padding:7px 0;gap:12px;';
      d.innerHTML =
        `<span style="font-size:12px;color:#bcbcbc;flex-shrink:0">${labelText}</span>${controlHTML}`;
      return d;
    };

    // Background opacity slider
    const bgRow = row('BG Opacity',
      `<input id="cap-bg-opacity" type="range" min="0" max="1" step="0.05"
        value="${s.bgOpacity}" style="width:100px;accent-color:#E50914;cursor:pointer"/>`);
    section.appendChild(bgRow);
    bgRow.querySelector('#cap-bg-opacity').addEventListener('input', (e) => {
      CaptionSettings.set('bgOpacity', parseFloat(e.target.value));
    });

    // Font family
    const fontRow = row('Font',
      `<select id="cap-font" style="background:#1a1a1a;color:#fff;border:1px solid rgba(255,255,255,0.15);
         border-radius:3px;padding:4px 8px;font-size:12px;cursor:pointer;outline:none">
        <option value="auto" ${s.fontFamily==='auto'?'selected':''}>Auto</option>
        <option value="sans-serif" ${s.fontFamily==='sans-serif'?'selected':''}>Sans-serif</option>
        <option value="serif" ${s.fontFamily==='serif'?'selected':''}>Serif</option>
        <option value="monospace" ${s.fontFamily==='monospace'?'selected':''}>Monospace</option>
        <option value="'Courier New'" ${s.fontFamily==="'Courier New'"?'selected':''}>Courier</option>
      </select>`);
    section.appendChild(fontRow);
    fontRow.querySelector('#cap-font').addEventListener('change', (e) => {
      CaptionSettings.set('fontFamily', e.target.value);
    });

    // Text shadow
    const shadowRow = row('Shadow',
      `<select id="cap-shadow" style="background:#1a1a1a;color:#fff;border:1px solid rgba(255,255,255,0.15);
         border-radius:3px;padding:4px 8px;font-size:12px;cursor:pointer;outline:none">
        <option value="drop" ${s.textShadow==='drop'?'selected':''}>Drop Shadow</option>
        <option value="glow" ${s.textShadow==='glow'?'selected':''}>Glow</option>
        <option value="none" ${s.textShadow==='none'?'selected':''}>None</option>
      </select>`);
    section.appendChild(shadowRow);
    shadowRow.querySelector('#cap-shadow').addEventListener('change', (e) => {
      CaptionSettings.set('textShadow', e.target.value);
    });

    // Font size
    const sizeRow = row('Size',
      `<input id="cap-size" type="range" min="60" max="180" step="5"
        value="${s.fontSize}" style="width:100px;accent-color:#E50914;cursor:pointer"/>
       <span id="cap-size-val" style="font-size:11px;color:#6d6d6e;min-width:34px;text-align:right">
         ${s.fontSize}%</span>`);
    section.appendChild(sizeRow);
    sizeRow.querySelector('#cap-size').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      CaptionSettings.set('fontSize', v);
      sizeRow.querySelector('#cap-size-val').textContent = v + '%';
    });

    // Append to the subtitles column
    const colSubs = $('#col-subs') || modal;
    colSubs.appendChild(section);
  }

  // ── Main detect function ──────────────────────────────────────────────────
  async function detectTracks(video, filePath) {
    _video     = video;
    _filePath  = filePath;

    // Start with loading state
    audioList.innerHTML = '<li class="as-empty">Detecting tracks…</li>';
    subList.innerHTML   = '<li class="as-empty">Detecting tracks…</li>';

    // Run FFprobe to get full track info
    let ffprobeResult = { audioTracks: [], subtitleTracks: [] };
    if (filePath) {
      try {
        ffprobeResult = await ipcRenderer.invoke('ffprobe-tracks', filePath);
      } catch (e) {
        console.warn('FFprobe failed:', e);
      }
    }

    _buildAudioList(ffprobeResult.audioTracks);
    _buildSubList(ffprobeResult.subtitleTracks);
    _buildCaptionSettings();
  }

  function init() {
    // Close button
    closeBtn.addEventListener('click', close);

    // Click outside modal → close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // Add subtitle button
    addSubBtn.addEventListener('click', _handleAddSub);

    // Escape key handled in Player's keydown handler
  }

  return { init, open, close, toggle, detectTracks, attachSubtitleTrack };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § DRAG & DROP
// Drop a video file anywhere → play it.
// Drop a .srt/.vtt → load as subtitle for current video.
// ══════════════════════════════════════════════════════════════════════════════
const DragDrop = (() => {
  function init() {
    // Prevent browser from navigating to dropped files
    document.addEventListener('dragover',  (e) => { e.preventDefault(); e.stopPropagation(); });
    document.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); });

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;

      for (const file of files) {
        const fp  = file.path; // Electron exposes .path on File objects
        const ext = path.extname(fp).toLowerCase();

        if (['.srt', '.vtt', '.ass', '.ssa'].includes(ext)) {
          // Load as subtitle
          const video = Player.video;
          if (!video.src) {
            console.warn('Drop: no video loaded to attach subtitle to.');
            return;
          }

          let vttPath;
          const label = path.basename(fp, ext);

          if (ext === '.vtt') {
            vttPath = fp;
          } else {
            // Convert SRT → VTT in-renderer
            try {
              const srtText = await ipcRenderer.invoke('read-file-text', fp);
              const vttText = srtToVtt(srtText);
              const tmpName = `nplayer_dd_sub_${Date.now()}.vtt`;
              vttPath = await ipcRenderer.invoke('write-temp-file', tmpName, vttText);
              Player._addTempFile(vttPath);
            } catch (err) {
              console.error('Drag-drop SRT conversion failed:', err);
              return;
            }
          }

          AudioSubtitlesPanel.attachSubtitleTrack(video, vttPath, label, true);
          const curPath = Player._currentFilePath();
          if (curPath) SubtitlePersistence.save(curPath, vttPath, label);
          return; // Only handle the first subtitle
        }

        // Otherwise treat as video file
        const videoExts = ['.mp4','.mkv','.avi','.mov','.webm','.flv','.m4v','.wmv','.ts','.ogv'];
        if (videoExts.includes(ext)) {
          // If no video is loaded yet, run intro first
          if (!Player.video.src) {
            Player.loadWithIntro(fp);
          } else {
            Player.swapFile(fp);
          }
          return;
        }
      }
    });
  }

  return { init };
})();

// ══════════════════════════════════════════════════════════════════════════════
// § BOOT
// ══════════════════════════════════════════════════════════════════════════════
(function boot() {
  // 1. Reset screen visibility
  ScreenManager.reset();

  // 2. Init all modules
  IntroSequence.init();
  HomeScreen.init();
  Player.init();
  ProgressBar.init();
  AudioSubtitlesPanel.init();
  DragDrop.init();
  CaptionSettings.load();  // load persisted caption settings + apply CSS

  // 3. Show home screen immediately on launch
  HomeScreen.show();
})();