/* =========================================================
   Manhunt Live — real-time GPS manhunt
   Vanilla JS + Leaflet + Firebase Realtime Database (compat)
   ========================================================= */
'use strict';

/* ---------------------------------------------------------
   1. FIREBASE CONFIG — replace with your project's settings
   (Firebase console → Project settings → Your apps → Web app)
   --------------------------------------------------------- */
const firebaseConfig = {
  apiKey: 'AIzaSyB9usU73Lj4YTGXxV8FyDpH7b9ut3nmUFw',
  authDomain: 'manhunt-5fc51.firebaseapp.com',
  databaseURL: 'https://manhunt-5fc51-default-rtdb.firebaseio.com',
  projectId: 'manhunt-5fc51',
  storageBucket: 'manhunt-5fc51.firebasestorage.app',
  messagingSenderId: '781429662353',
  appId: '1:781429662353:web:7260467466f196ac285530',
};

/* ---------------------------------------------------------
   2. CONSTANTS & IDENTITY
   --------------------------------------------------------- */
const DEFAULT_ROOM = 'park-hunt-1';
const COLORS = { hunter: '#ff2d4b', runner: '#1f8bff', spectator: '#a855f7', none: '#6b7588' };
const POSITION_PUSH_INTERVAL_MS = 1000;
const LS = {
  playerId: 'manhunt.playerId',
  name: 'manhunt.name',
  settings: 'manhunt.settings',
  role: (room) => `manhunt.role.${room}`,
  pings: (room, startedAt) => `manhunt.pings.${room}.${startedAt}`,
  lastRoom: 'manhunt.lastRoom',
};

/* Distance standard: all game settings are in FEET; Leaflet works in METERS. */
const FT_TO_M = 0.3048;
const ftToM = (ft) => ft * FT_TO_M;

/* Room lifecycle: lobby → grace_period → playing → game_over → lobby */
const STATUS = { LOBBY: 'lobby', GRACE: 'grace_period', PLAYING: 'playing', GAME_OVER: 'game_over' };
const ACTIVE_STATUSES = new Set([STATUS.GRACE, STATUS.PLAYING, STATUS.GAME_OVER]);

const ZONE_COLOR = '#ef4444';
const ZONE_TICK_MS = 5000;            // host shrinks the zone every 5 s (rate / 12 per tick)
const GAME_TICK_MS = 500;             // UI countdowns
const PING_COOLDOWN_MS = 60000;       // 1 minute cooldown between pings
const GHOST_DURATION_MS = 15000;      // 15 seconds snapshot marker visibility

function maxPingsForDuration(durationMin) {
  return Math.max(1, Math.floor((durationMin || 15) / 5));
}

/** Firebase keys can't contain . # $ [ ] / — sanitize the room id. */
function sanitizeRoom(raw) {
  if (!raw) return '';
  return raw.trim().toLowerCase().replace(/[.#$[\]/\s]+/g, '-').slice(0, 64);
}

const ROOM_ID = sanitizeRoom(new URLSearchParams(location.search).get('room'))
  || sanitizeRoom(localStorage.getItem(LS.lastRoom)) || DEFAULT_ROOM;
localStorage.setItem(LS.lastRoom, ROOM_ID);

/** Anonymous, persistent player ID — survives reloads so we never duplicate players. */
function getPlayerId() {
  let id = localStorage.getItem(LS.playerId);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
      .replace(/-/g, '').slice(0, 20);
    localStorage.setItem(LS.playerId, id);
  }
  return id;
}
const PLAYER_ID = getPlayerId();

/* ---------------------------------------------------------
   3. APP STATE
   --------------------------------------------------------- */
const S = {
  joined: false,
  name: '',
  loaded: false,          // first room snapshot received
  connected: false,
  serverOffset: 0,
  room: {},               // rooms/{id}/state
  players: {},            // rooms/{id}/players (only valid entries)
  inGame: false,
  revealedFor: null,      // startedAt of the game whose role splash we've shown
  myPos: null,            // { lat, lng, acc }
  gpsError: '',
  follow: true,
  firstFix: true,
  watchId: null,
  wakeLock: null,
  lastPush: 0,
  pushTimer: null,
  tickInterval: null,
  shrinkInterval: null,
  markers: new Map(),     // playerId -> L.circleMarker
  ghostMarkers: new Map(),// runnerId -> { marker, timer }
  accuracyCircle: null,
  zoneCircle: null,
  hostClaimPending: false,
  transitionPending: false,
  lastPhase: null,
  dismissedCaught: false,
  // Safe zone
  distFeet: null,
  exposed: false,
  lastSirenAt: 0,
  // Hunter radar & Supply drops
  pingKey: null,
  pingsUsed: 0,
  pingCooldownUntil: 0,
  pingRevealUntil: 0,
  pingWasActive: false,
  lastHandledPingAt: null,
  hunterReconUntil: 0,
  supplyDropMarker: null,
  collectingDrop: false,
  lastHeartbeatAt: 0,
  // Last Man Standing
  lmsHandled: false,
  lmsBannerTimer: null,
  lmsTriggerPending: false,
  // Infection mode
  infectPending: false,   // 3 s takeover overlay still showing → keep runner UI
  infectedHandled: null,  // infectedAt value we've already reacted to
  seenActivity: new Set(),
  activityPrimed: false,
  omniUntil: 0,           // admin Omni-Ping reveal window
  codeRepairPending: false,
  selfTagging: false,
};

/** Lobby zone-preview map state (host only). */
const P = { map: null, circle: null, minCircle: null, centerMarker: null, mainCircle: null, manualCenter: null, fitted: false, shown: false };

/* ---------------------------------------------------------
   4. DOM
   --------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const el = {
  lobby: $('lobby'),
  roomName: $('room-name'),
  shareBtn: $('share-btn'),
  configWarning: $('config-warning'),
  joinView: $('join-view'),
  nameInput: $('name-input'),
  joinBtn: $('join-btn'),
  waitingCount: $('waiting-count'),
  roomInput: $('room-input'),
  chatFab: $('chat-fab'),
  chatBadge: $('chat-badge'),
  chatPanel: $('chat-panel'),
  chatTitle: $('chat-title'),
  chatClose: $('chat-close'),
  chatTabs: $('chat-tabs'),
  chatLog: $('chat-log'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  lobbyView: $('lobby-view'),
  lobbyCount: $('lobby-count'),
  playerList: $('player-list'),
  hostControls: $('host-controls'),
  hunterCount: $('hunter-count'),
  hunterMinus: $('hunter-minus'),
  hunterPlus: $('hunter-plus'),
  startBtn: $('start-btn'),
  guestWait: $('guest-wait'),
  leaveBtn: $('leave-btn'),
  // Presets & Host settings
  presetBlitz: $('preset-blitz'),
  presetTactical: $('preset-tactical'),
  durationSlider: $('duration-slider'),
  durationValue: $('duration-value'),
  graceSlider: $('grace-slider'),
  graceValue: $('grace-value'),
  radiusSlider: $('radius-slider'),
  radiusValue: $('radius-value'),
  shrinkToggle: $('shrink-toggle'),
  shrinkPaceSelect: $('shrink-pace-select'),
  oobPenaltySelect: $('oob-penalty-select'),
  supplyDropToggle: $('supply-drop-toggle'),
  lmsToggle: $('lms-toggle'),
  minRadiusGroup: $('min-radius-group'),
  minRadiusSlider: $('min-radius-slider'),
  minRadiusValue: $('min-radius-value'),
  shrinkSpeedGroup: $('shrink-speed-group'),
  shrinkSlider: $('shrink-slider'),
  shrinkValue: $('shrink-value'),
  zoneSummary: $('zone-summary'),
  zonePreviewMap: $('zone-preview-map'),
  zonePreviewStatus: $('zone-preview-status'),
  zoneCenterTag: $('zone-center-tag'),
  zoneRecenterBtn: $('zone-recenter-btn'),
  // HUD
  topHudBar: $('top-hud-bar'),
  statusPill: $('top-hud-bar'),
  roleChip: $('role-chip'),
  matchTimer: $('match-timer'),
  gameTimer: $('match-timer'),
  rosterToggleBtn: $('roster-toggle-btn'),
  aliveCount: $('alive-count'),
  playerCount: $('alive-count'),
  runnerTagPill: $('runner-code-badge'),
  runnerTagCode: $('my-code-val'),
  selfTagBtn: $('self-tag-btn'),
  selfTagConfirm: $('self-tag-confirm'),
  selfTagYes: $('self-tag-yes'),
  selfTagCancel: $('self-tag-cancel'),
  adminPanel: $('secret-admin-panel'),
  adminClose: $('admin-close'),
  adminSpectate: $('admin-spectate'),
  adminOmni: $('admin-omni'),
  adminPause: $('admin-pause'),
  adminExpand: $('admin-expand'),
  adminShrink: $('admin-shrink'),
  adminAddTime: $('admin-addtime'),
  adminEnd: $('admin-end'),
  adminPlayerList: $('admin-player-list'),
  hunterTagBar: $('hunter-tag-bar'),
  tagCodeInput: $('tag-code-input'),
  tagSubmitBtn: $('tag-submit-btn'),
  caughtOverlay: $('caught-overlay'),
  caughtByText: $('caught-by-text'),
  caughtDismissBtn: $('caught-dismiss-btn'),
  gameOverModal: $('game-over-modal'),
  winnerTrophy: $('winner-trophy'),
  winnerTitle: $('winner-title'),
  winnerSub: $('winner-sub'),
  statSurvivors: $('stat-survivors'),
  statEliminated: $('stat-eliminated'),
  gameOverLobbyBtn: $('game-over-lobby-btn'),
  reconnectBanner: $('reconnect-banner'),
  lmsBanner: $('lms-banner'),
  lmsBannerText: $('lms-banner-text'),
  graceBanner: $('grace-banner'),
  graceText: $('grace-text'),
  graceSub: $('grace-sub'),
  graceProgress: $('grace-progress-bar'),
  zoneBanner: $('zone-banner'),
  zoneBannerText: $('zone-banner-text'),
  gpsBanner: $('gps-banner'),
  gpsBannerText: $('gps-banner-text'),
  hunterLock: $('hunter-lock'),
  hunterLockTime: $('hunter-lock-time'),
  radarSweep: $('radar-sweep'),
  pingBtn: $('ping-btn'),
  pingLabel: $('ping-label'),
  gameControls: $('game-controls'),
  endGameBtn: $('end-game-btn'),
  zoneChip: $('zone-chip'),
  zoneChipText: $('zone-chip-text'),
  gpsChip: $('gps-chip'),
  gpsAccuracy: $('gps-accuracy'),
  recenterBtn: $('recenter-btn'),
  reveal: $('reveal'),
  revealRole: $('reveal-role'),
  revealSub: $('reveal-sub'),
  toastStack: $('toast-stack'),
  infectionToggle: $('infection-toggle'),
  infectedOverlay: $('infected-overlay'),
  statEliminatedLabel: $('stat-eliminated-label'),
  rosterBackdrop: $('roster-backdrop'),
  rosterDrawer: $('roster-drawer'),
  rosterSummary: $('roster-summary'),
  rosterClose: $('roster-close'),
  rosterAdminBtn: $('roster-admin-btn'),
  lobbyAdminBtn: $('lobby-admin-btn'),
  appTitle: $('app-title'),
  rosterBody: $('roster-body'),
};
const SLIDERS = [el.durationSlider, el.radiusSlider, el.minRadiusSlider, el.shrinkSlider, el.graceSlider];

/* ---------------------------------------------------------
   5. UTILITIES
   --------------------------------------------------------- */
function toast(msg, type = '', ms = 2800) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  el.toastStack.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 45%)`;
}

function serverNow() { return Date.now() + S.serverOffset; }

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

/** Countdown "MM:SS" — rounds up so it hits 00:00 exactly when time is up. */
function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Seconds → "M:SS" (slider readouts). */
function formatMSS(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

const fmtFt = (ft) => Math.round(ft).toLocaleString();

function vibrate(pattern) { if (navigator.vibrate) navigator.vibrate(pattern); }

function isAdminPasscode(code) {
  if (code === null || code === undefined) return false;
  const s = String(code).trim().replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return s === '8623';
}

function promptAdminPasscode() {
  const code = prompt('Enter passcode:');
  if (code === null) return;
  if (isAdminPasscode(code)) {
    vibrate([80, 40, 80]);
    openAdminPanel();
    toast('🔓 Admin Mode Unlocked');
  } else if (code.trim() !== '') {
    vibrate([100, 50, 100]);
    toast('❌ Incorrect passcode', 'error');
  }
}

/* ---------- Web Audio API Cues ---------- */
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => { });
  }
  return audioCtx;
}
['click', 'touchstart', 'keydown'].forEach((ev) => {
  window.addEventListener(ev, () => { getAudioCtx(); }, { once: true, passive: true });
});

/** Out-of-Bounds Siren: descending dual-tone sweep (800Hz to 400Hz) paired with navigator.vibrate([300, 100, 300, 100, 300]) */
function playSiren() {
  try {
    const ctx = getAudioCtx();
    if (ctx) {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sawtooth';
      osc2.type = 'triangle';

      osc1.frequency.setValueAtTime(800, now);
      osc1.frequency.exponentialRampToValueAtTime(400, now + 0.8);

      osc2.frequency.setValueAtTime(808, now);
      osc2.frequency.exponentialRampToValueAtTime(404, now + 0.8);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.85);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.9);
      osc2.stop(now + 0.9);
    }
  } catch (err) { }
  vibrate([300, 100, 300, 100, 300]);
}

/** Radar Ping Sonar: soft 1200Hz sonar chime and brief vibrate pattern ([80, 50, 80]) on runner devices */
function playSonarChime() {
  try {
    const ctx = getAudioCtx();
    if (ctx) {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, now);

      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.65);
    }
  } catch (err) { }
  vibrate([80, 50, 80]);
}

/** Proximity Heartbeat: low 150Hz pulse and subtle vibration ([50]) */
function playHeartbeatPulse() {
  try {
    const ctx = getAudioCtx();
    if (ctx) {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, now);

      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.4);
    }
  } catch (err) { }
  vibrate([50]);
}

/** Last Man Standing Alert: low alert tone and haptic vibration ([100, 50, 100, 50, 300]) */
function playLmsAlertTone() {
  try {
    const ctx = getAudioCtx();
    if (ctx) {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(140, now + 0.6);

      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.7);
    }
  } catch (err) { }
  vibrate([100, 50, 100, 50, 300]);
}

/** Unbiased random integer in [0, max) using crypto + rejection sampling. */
function randomInt(max) {
  if (window.crypto && crypto.getRandomValues) {
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % max;
  }
  return Math.floor(Math.random() * max);
}

/** Fisher–Yates (Durstenfeld) shuffle — returns a new array, every permutation equally likely. */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Explicit 4-digit runner code, strictly 1000–9998 (8623 is reserved for admin access). */
function generateTagCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 8999).toString();
  } while (code === '8623');
  return code;
}

const isHost = () => S.room.hostId === PLAYER_ID;
const me = () => S.players[PLAYER_ID];
const myRole = () => {
  const r = me()?.role || null;
  // Hold the runner UI until the infection takeover overlay finishes.
  return S.infectPending && r === 'hunter' ? 'runner' : r;
};
const isInfection = () => S.room.gameMode === 'infection';
const isActive = () => ACTIVE_STATUSES.has(S.room.state || S.room.status);

/**
 * Effective game phase. If the grace timer has expired but the host hasn't
 * flipped the DB status yet (e.g. host briefly offline), treat it as playing
 * locally so hunters are never stuck frozen.
 */
function phase() {
  const st = S.room.state || S.room.status || STATUS.LOBBY;
  if (st === STATUS.GRACE && S.room.graceEndsAt && serverNow() >= S.room.graceEndsAt) return STATUS.PLAYING;
  return st;
}

/** Valid zone object from the room state, or null. */
function zone() {
  const z = S.room.zone;
  return z && typeof z.centerLat === 'number' && typeof z.centerLng === 'number' && typeof z.currentRadiusFeet === 'number'
    ? z : null;
}

/* ---------------------------------------------------------
   6. MAP
   --------------------------------------------------------- */
const TILE_SATELLITE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

function addBaseLayers(target) {
  // High-resolution satellite imagery
  L.tileLayer(TILE_SATELLITE, {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  }).addTo(target);

  // Road lines and street labels overlay
  L.tileLayer(TILE_LABELS, { maxZoom: 19 }).addTo(target);
}

const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([39.8283, -98.5795], 4);
addBaseLayers(map);

// Visual distance scale on the map (imperial feet/miles)
L.control.scale({ imperial: true, metric: false, position: 'bottomright' }).addTo(map);

// If the user pans manually, stop auto-following until they tap re-center.
map.on('dragstart', () => setFollow(false));

function setFollow(on) {
  S.follow = on;
  el.recenterBtn.classList.toggle('following', on);
  el.recenterBtn.classList.toggle('detached', !on);
  if (on) centerOnMe(true);
}

function centerOnMe(animate = true) {
  if (!S.myPos) return;
  const target = [S.myPos.lat, S.myPos.lng];
  if (S.firstFix) {
    S.firstFix = false;
    map.setView(target, 18, { animate: false });
  } else {
    map.panTo(target, { animate, duration: 0.5 });
  }
}

/* ---------- Stealth visibility rules ---------- */
const pingActive = () => Date.now() < S.pingRevealUntil;

/**
 * Who can see whom:
 *  - You always see yourself.
 *  - Runners see all active players.
 *  - Eliminated players do not appear to hunters.
 *  - Hunters always see fellow hunters.
 *  - Hunters NEVER see runners during the grace period.
 *  - During the hunt, runners are 100% invisible to hunters by default.
 *  - If a runner is outside the safe zone (exposed), their live marker
 *    appears in blinking red on all hunters' maps until they return inside.
 */
const omniActive = () => Date.now() < S.omniUntil;

function isVisibleToMe(id, p) {
  if (id === PLAYER_ID) return true;
  if (myRole() === 'spectator') return true; // Spectator has God's Eye visibility of all players
  if (omniActive() && p.role === 'runner' && !p.eliminated) return true; // admin Omni-Ping
  if (Date.now() < S.hunterReconUntil && p.role === 'hunter' && !p.eliminated) return true; // Runner Recon
  if (p.eliminated && myRole() === 'hunter') return false;
  if (myRole() !== 'hunter') return true;
  if (p.role === 'hunter') return true;
  if (phase() !== STATUS.PLAYING) return false;
  return p.exposed === true;
}

function renderMarkers() {
  const seen = new Set();
  if (!S.inGame) { clearMarkers(); return; }

  for (const [id, p] of Object.entries(S.players)) {
    const isMe = id === PLAYER_ID;
    if (!isVisibleToMe(id, p)) continue;
    // Use local GPS for our own marker (instant), DB data for everyone else.
    const lat = isMe && S.myPos ? S.myPos.lat : p.lat;
    const lng = isMe && S.myPos ? S.myPos.lng : p.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    seen.add(id);

    const role = p.role === 'hunter' || p.role === 'runner' || p.role === 'spectator' ? p.role : 'none';
    const exposed = phase() === STATUS.PLAYING && (isMe ? S.exposed : p.exposed === true);
    const outOfBounds = p.role === 'runner' && exposed;
    const isRecon = Date.now() < S.hunterReconUntil && role === 'hunter' && !isMe;

    const style = {
      radius: isMe ? 12 : 10,
      color: outOfBounds ? '#ffffff' : (isRecon ? '#38bdf8' : (exposed ? ZONE_COLOR : '#ffffff')),
      weight: isMe ? 4 : 3,
      fillColor: outOfBounds ? '#ef4444' : (isRecon ? '#0284c7' : COLORS[role]),
      fillOpacity: 1,
    };

    let label;
    if (outOfBounds) {
      label = `<span class="tip tip-runner tip-out-of-bounds">${escapeHtml(p.name)} (OUT OF BOUNDS)</span>`;
    } else if (isRecon) {
      label = `<span class="tip tip-hunter tip-recon">🎯 ${escapeHtml(p.name)} (RECON)</span>`;
    } else if (role === 'spectator') {
      label = `<span class="tip tip-spectator${isMe ? ' tip-me' : ''}">👁️ ${escapeHtml(p.name)}${isMe ? ' (You - Spectator)' : ' (Spectator)'}</span>`;
    } else if (p.eliminated && myRole() === 'spectator') {
      label = `<span class="tip tip-runner" style="opacity:0.7">💀 ${escapeHtml(p.name)} (Eliminated)</span>`;
    } else {
      label = `<span class="tip tip-${role}${isMe ? ' tip-me' : ''}${exposed ? ' tip-exposed' : ''}">`
        + `${exposed ? '⚠️ ' : ''}${escapeHtml(p.name)}${isMe ? ' (You)' : ''}</span>`;
    }

    let m = S.markers.get(id);
    if (!m) {
      m = L.circleMarker([lat, lng], style).addTo(map);
      m.bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -14], className: 'player-tip' });
      S.markers.set(id, m);
    } else {
      m.setLatLng([lat, lng]);
      m.setStyle(style);
      m.setTooltipContent(label);
    }
    if (isMe) m.bringToFront();
  }

  // Remove markers for players who left (or who are now hidden from us).
  for (const [id, m] of S.markers) {
    if (!seen.has(id)) { map.removeLayer(m); S.markers.delete(id); }
  }

  // Accuracy halo for the local player.
  if (S.myPos && S.inGame) {
    const color = COLORS[myRole() || 'none'];
    if (!S.accuracyCircle) {
      S.accuracyCircle = L.circle([S.myPos.lat, S.myPos.lng], {
        radius: S.myPos.acc, color, weight: 1, fillColor: color, fillOpacity: 0.12, interactive: false,
      }).addTo(map);
    } else {
      S.accuracyCircle.setLatLng([S.myPos.lat, S.myPos.lng]);
      S.accuracyCircle.setRadius(S.myPos.acc);
      S.accuracyCircle.setStyle({ color, fillColor: color });
    }
  }
}

function clearGhostMarkers() {
  for (const item of S.ghostMarkers.values()) {
    if (item.timer) clearTimeout(item.timer);
    if (item.marker) map.removeLayer(item.marker);
  }
  S.ghostMarkers.clear();
}

function clearMarkers() {
  for (const m of S.markers.values()) map.removeLayer(m);
  S.markers.clear();
  clearGhostMarkers();
  if (S.accuracyCircle) { map.removeLayer(S.accuracyCircle); S.accuracyCircle = null; }
}

/* ---------- Safe zone circle (red dashed) ---------- */
function renderZone() {
  const z = zone();
  if (!S.inGame || !z) {
    if (S.zoneCircle) { map.removeLayer(S.zoneCircle); S.zoneCircle = null; }
    return;
  }
  const center = [z.centerLat, z.centerLng];
  const radiusM = ftToM(z.currentRadiusFeet);
  if (!S.zoneCircle) {
    S.zoneCircle = L.circle(center, {
      radius: radiusM,
      color: ZONE_COLOR,
      weight: 3,
      dashArray: '8, 8',
      fillColor: ZONE_COLOR,
      fillOpacity: 0.06,
      interactive: false,
    }).addTo(map);
    S.zoneCircle.bringToBack();
  } else {
    S.zoneCircle.setLatLng(center);
    S.zoneCircle.setRadius(radiusM);
  }
}

/* ---------------------------------------------------------
   7. FIREBASE SETUP
   --------------------------------------------------------- */
const isConfigured = !Object.values(firebaseConfig).some((v) => String(v).includes('YOUR_'));
let db, roomRef, stateRef, playersRef, meRef;

function initFirebase() {
  el.roomName.textContent = ROOM_ID;
  el.nameInput.value = localStorage.getItem(LS.name) || '';
  el.roomInput.value = ROOM_ID;

  if (!isConfigured) {
    el.configWarning.classList.remove('hidden');
    el.joinBtn.disabled = true;
    el.waitingCount.textContent = 'Add your Firebase config to play.';
    return;
  }

  firebase.initializeApp(firebaseConfig);
  db = firebase.database();
  roomRef = db.ref(`rooms/${ROOM_ID}`);
  stateRef = roomRef.child('state');
  playersRef = roomRef.child('players');
  meRef = playersRef.child(PLAYER_ID);

  db.ref('.info/serverTimeOffset').on('value', (snap) => { S.serverOffset = snap.val() || 0; });
  db.ref('.info/connected').on('value', onConnectionChange);

  // One listener for the whole room = state + players always arrive consistently together.
  roomRef.on('value', onRoomSnapshot, (err) => {
    console.error(err);
    toast(`Database error: ${err.message}`, 'error', 5000);
  });
}

/** (Re)registers presence every time the socket (re)connects. */
function onConnectionChange(snap) {
  S.connected = snap.val() === true;
  if (el.reconnectBanner) {
    el.reconnectBanner.classList.toggle('hidden', S.connected);
  }
  if (!S.connected) {
    if (S.joined) toast('Connection lost — reconnecting…', 'warn');
    return;
  }
  if (!S.joined) return;
  registerPresence();
}

async function registerPresence() {
  // Prevent background disconnects / screen lock from removing players or dropping host privileges.
  try {
    await meRef.onDisconnect().cancel();
    if (isHost()) await stateRef.child('hostId').onDisconnect().cancel();
  } catch (err) { }

  const role = isActive() ? (myRole() || restoreRole() || 'runner') : null;
  const existing = me();
  const updateData = {
    name: S.name,
    joinedAt: existing?.joinedAt || firebase.database.ServerValue.TIMESTAMP,
    exposed: S.exposed,
    lastSeen: firebase.database.ServerValue.TIMESTAMP,
    updatedAt: firebase.database.ServerValue.TIMESTAMP,
  };
  if (role && !existing?.role) {
    updateData.role = role;
  }
  if (S.myPos) {
    updateData.lat = S.myPos.lat;
    updateData.lng = S.myPos.lng;
    updateData.acc = Math.round(S.myPos.acc);
  }
  await meRef.update(updateData);
}

/* ---------------------------------------------------------
   8. ROOM SNAPSHOT → UI
   --------------------------------------------------------- */
function onRoomSnapshot(snap) {
  const v = snap.val() || {};
  S.room = v.state || {};
  // Ignore partial/ghost nodes (e.g. a role written to a player who just left).
  S.players = Object.fromEntries(
    Object.entries(v.players || {}).filter(([, p]) => p && typeof p.name === 'string')
  );
  S.loaded = true;
  renderChat(v.chat);

  // Room activity feed (e.g. infection announcements) — toast only new events.
  const feed = Object.entries(v.activity || {}).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  for (const [key, ev] of feed) {
    if (S.seenActivity.has(key)) continue;
    S.seenActivity.add(key);
    if (S.activityPrimed && S.joined && ev && ev.text) toast(ev.text, 'warn', 4500);
  }
  S.activityPrimed = true;

  // Radar Ping Sonar chime for runners when a hunter fires ping
  if (S.room.lastPingAt && S.room.lastPingAt !== S.lastHandledPingAt) {
    if (S.lastHandledPingAt !== null && S.joined && S.inGame && myRole() === 'runner' && phase() === STATUS.PLAYING) {
      playSonarChime();
    }
    S.lastHandledPingAt = S.room.lastPingAt;
  }

  // Did I just get infected?
  const mine = S.players[PLAYER_ID];
  if (S.joined && S.inGame && mine?.infectedAt && S.infectedHandled !== mine.infectedAt) {
    S.infectedHandled = mine.infectedAt;
    if (Date.now() - mine.infectedAt < 15000) triggerInfection();
  }

  // Last Man Standing activation check
  if (S.room.lastManStandingActive && !S.lmsHandled) {
    S.lmsHandled = true;
    if (S.joined && S.inGame) {
      playLmsAlertTone();
      showLmsBanner(S.room.soleSurvivorName);
    }
  } else if (!S.room.lastManStandingActive) {
    S.lmsHandled = false;
    hideLmsBanner();
  }

  const count = Object.keys(S.players).length;
  if (!S.joined) {
    el.waitingCount.textContent = count
      ? `${count} player${count === 1 ? '' : 's'} in this room${isActive() ? ' · game in progress' : ''}`
      : 'Be the first to join — you\'ll be the host.';
  }

  if (S.joined) {
    maybeClaimHost();
    renderLobby();

    if (isActive() && !S.inGame) enterGame();
    else if (!isActive() && S.inGame) exitGame();

    if (S.inGame) {
      persistRole();
      syncPingStore();
      maybeShowReveal();
      renderSupplyDrop();
      refreshGame();
    }
  }
}

function renderLobby() {
  const entries = Object.entries(S.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  el.lobbyCount.textContent = entries.length;

  const frag = document.createDocumentFragment();
  for (const [id, p] of entries) {
    const li = document.createElement('li');
    li.className = `player-item${id === PLAYER_ID ? ' is-me' : ''}`;

    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = hashColor(id);
    av.textContent = (p.name.trim()[0] || '?').toUpperCase();

    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = p.name;

    li.append(av, name);
    if (id === S.room.hostId) li.append(makeBadge('HOST', 'badge-host'));
    if (id === PLAYER_ID) li.append(makeBadge('YOU', 'badge-you'));
    frag.appendChild(li);
  }
  el.playerList.replaceChildren(frag);

  const host = isHost();
  el.hostControls.classList.toggle('hidden', !host);
  el.guestWait.classList.toggle('hidden', host);

  // Lazily create / resize the zone preview map the moment it becomes visible.
  if (host && !S.inGame && !P.shown) {
    P.shown = true;
    requestAnimationFrame(ensurePreviewMap);
  } else if (!host) {
    P.shown = false;
  }

  // Keep the hunter input within sensible bounds.
  const maxHunters = Math.max(1, entries.length - 1);
  el.hunterCount.max = maxHunters;
  if (Number(el.hunterCount.value) > maxHunters) el.hunterCount.value = maxHunters;
}

function makeBadge(text, cls) {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

/* ---------------------------------------------------------
   9. HOST ELECTION
   First player in becomes host. If the host leaves, the
   earliest-joined remaining player claims it via transaction.
   --------------------------------------------------------- */
function maybeClaimHost() {
  if (!S.loaded || !S.connected || !me() || S.hostClaimPending) return;
  const hostId = S.room.hostId;
  if (hostId === PLAYER_ID) return;
  if (hostId && S.players[hostId]) return; // a live host exists

  // Only the earliest-joined present player attempts, to honor "first in = host".
  const earliest = Object.entries(S.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))[0];
  if (earliest && earliest[0] !== PLAYER_ID) return;

  S.hostClaimPending = true;
  stateRef.child('hostId').transaction((cur) => {
    if (!cur || cur === PLAYER_ID || !S.players[cur]) return PLAYER_ID;
    return; // abort — someone else is host
  }).then(async ({ committed, snapshot }) => {
    if (committed && snapshot.val() === PLAYER_ID) {
      try { await stateRef.child('hostId').onDisconnect().cancel(); } catch (e) { }
      toast('👑 You are now the host');
    }
  }).catch(console.error).finally(() => { S.hostClaimPending = false; });
}

/* ---------------------------------------------------------
   10. HOST SETTINGS — sliders + live zone preview
   --------------------------------------------------------- */
function readSettings() {
  return {
    durationMin: Number(el.durationSlider.value) || 15,
    graceSec: Number(el.graceSlider.value),
    startRadiusFt: Number(el.radiusSlider.value),
    minRadiusFt: Number(el.minRadiusSlider.value),
    shrinkFtPerMin: Number(el.shrinkSlider.value) || 150,
    shrinkEnabled: el.shrinkToggle ? el.shrinkToggle.checked : true,
    supplyDropEnabled: el.supplyDropToggle ? el.supplyDropToggle.checked : true,
    lmsEnabled: el.lmsToggle ? el.lmsToggle.checked : true,
    oobPenalty: el.oobPenaltySelect ? el.oobPenaltySelect.value : 'standard',
  };
}

/** Applies quick host configuration presets */
function applyPreset(type) {
  if (type === 'blitz') {
    // "Quick Blitz": 10m match, 45s grace, 150 ft/min, Infection ON, LMS ON, Drops OFF.
    el.durationSlider.value = 10;
    el.graceSlider.value = 45;
    if (el.shrinkPaceSelect) el.shrinkPaceSelect.value = '150';
    el.shrinkSlider.value = 150;
    if (el.infectionToggle) el.infectionToggle.checked = true;
    if (el.lmsToggle) el.lmsToggle.checked = true;
    if (el.supplyDropToggle) el.supplyDropToggle.checked = false;
    if (el.shrinkToggle) el.shrinkToggle.checked = true;
    toast('⚡ Quick Blitz preset applied');
  } else if (type === 'tactical') {
    // "Big Park Tactical": 20m match, 90s grace, 100 ft/min, Infection ON, LMS ON, Drops ON.
    el.durationSlider.value = 20;
    el.graceSlider.value = 90;
    if (el.shrinkPaceSelect) el.shrinkPaceSelect.value = '100';
    el.shrinkSlider.value = 100;
    if (el.infectionToggle) el.infectionToggle.checked = true;
    if (el.lmsToggle) el.lmsToggle.checked = true;
    if (el.supplyDropToggle) el.supplyDropToggle.checked = true;
    if (el.shrinkToggle) el.shrinkToggle.checked = true;
    toast('🌲 Big Park Tactical preset applied');
  }
  vibrate(20);
  renderSettings();
  updatePreview(false);
}

/** Paints the filled part of a range track via a CSS variable. */
function setFill(input) {
  if (!input) return;
  const min = Number(input.min), max = Number(input.max);
  input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

function renderSettings() {
  const s = readSettings();
  const minR = Math.min(s.minRadiusFt, s.startRadiusFt);
  const pings = maxPingsForDuration(s.durationMin);

  el.durationValue.textContent = `Match Duration: ${s.durationMin} min (${pings} ping${pings === 1 ? '' : 's'})`;
  el.graceValue.textContent = `Grace Period: ${formatMSS(s.graceSec)}`;
  el.radiusValue.textContent = `Starting Radius: ${fmtFt(s.startRadiusFt)} ft`;

  if (el.shrinkPaceSelect && String(s.shrinkFtPerMin) !== el.shrinkPaceSelect.value) {
    el.shrinkPaceSelect.value = String(s.shrinkFtPerMin);
  }

  if (!s.shrinkEnabled) {
    el.minRadiusSlider.disabled = true;
    el.shrinkSlider.disabled = true;
    if (el.shrinkPaceSelect) el.shrinkPaceSelect.disabled = true;
    el.minRadiusGroup.classList.add('disabled');
    el.shrinkSpeedGroup.classList.add('disabled');
    el.minRadiusValue.textContent = 'Min Radius: Disabled (No Shrink)';
    el.shrinkValue.textContent = 'Shrink Speed: Disabled (Static Zone)';
    el.zoneSummary.textContent =
      `Hunt starts after ${formatMSS(s.graceSec)} · zone remains static at ${fmtFt(s.startRadiusFt)} ft for full ${s.durationMin} min`;
  } else {
    el.minRadiusSlider.disabled = false;
    el.shrinkSlider.disabled = false;
    if (el.shrinkPaceSelect) el.shrinkPaceSelect.disabled = false;
    el.minRadiusGroup.classList.remove('disabled');
    el.shrinkSpeedGroup.classList.remove('disabled');
    el.minRadiusValue.textContent = `Min Radius: ${fmtFt(minR)} ft`;
    el.shrinkValue.textContent = `Shrink Speed: ${fmtFt(s.shrinkFtPerMin)} ft/min`;
    const mins = (s.startRadiusFt - minR) / Math.max(1, s.shrinkFtPerMin);
    el.zoneSummary.textContent =
      `Hunt starts after ${formatMSS(s.graceSec)} · zone closes to ${fmtFt(minR)} ft in ~${mins < 1 ? '<1' : mins.toFixed(1)} min (${fmtFt(s.shrinkFtPerMin)} ft/min)`;
  }
  SLIDERS.forEach(setFill);

  try { localStorage.setItem(LS.settings, JSON.stringify(s)); } catch { /* ignore */ }
}

function restoreSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS.settings) || 'null');
    if (s) {
      if (s.durationMin) el.durationSlider.value = s.durationMin;
      if (s.graceSec) el.graceSlider.value = s.graceSec;
      if (s.startRadiusFt) el.radiusSlider.value = s.startRadiusFt;
      if (s.minRadiusFt) el.minRadiusSlider.value = s.minRadiusFt;
      if (s.shrinkFtPerMin) {
        el.shrinkSlider.value = s.shrinkFtPerMin;
        if (el.shrinkPaceSelect) el.shrinkPaceSelect.value = String(s.shrinkFtPerMin);
      }
      if (typeof s.shrinkEnabled === 'boolean' && el.shrinkToggle) {
        el.shrinkToggle.checked = s.shrinkEnabled;
      }
      if (typeof s.supplyDropEnabled === 'boolean' && el.supplyDropToggle) {
        el.supplyDropToggle.checked = s.supplyDropEnabled;
      }
      if (typeof s.lmsEnabled === 'boolean' && el.lmsToggle) {
        el.lmsToggle.checked = s.lmsEnabled;
      }
      if (s.oobPenalty && el.oobPenaltySelect) {
        el.oobPenaltySelect.value = s.oobPenalty;
      }
    }
  } catch { /* ignore */ }
  renderSettings();
}

/** Zone center: manual tap on the preview map, else the host's live GPS. */
function zoneCenter() {
  if (P.manualCenter) return P.manualCenter;
  if (S.myPos) return { lat: S.myPos.lat, lng: S.myPos.lng };
  return null;
}

function ensurePreviewMap() {
  if (!el.zonePreviewMap.getClientRects().length) { P.shown = false; return; } // not visible yet
  if (!P.map) {
    P.map = L.map(el.zonePreviewMap, { zoomControl: true, attributionControl: false, scrollWheelZoom: 'center' });
    addBaseLayers(P.map);
    const c = zoneCenter();
    P.map.setView(c ? [c.lat, c.lng] : map.getCenter(), c ? 16 : 4);
    P.map.on('click', (e) => {
      P.manualCenter = { lat: e.latlng.lat, lng: e.latlng.lng };
      vibrate(10);
      updatePreview(false);
    });
  } else {
    P.map.invalidateSize();
  }
  updatePreview(!P.fitted);
}

/** Draws/updates the preview circles. `fit` re-frames the map around the starting radius. */
function updatePreview(fit = false) {
  const c = zoneCenter();
  el.zonePreviewStatus.classList.toggle('hidden', !!c);
  if (!c) {
    el.zonePreviewStatus.textContent = S.gpsError
      ? `${S.gpsError} Tap the map to place the zone manually.`
      : 'Locating you… (or tap the map to place the zone)';
  }
  el.zoneCenterTag.textContent = P.manualCenter ? '📍 Custom center' : '📍 Centered on you';
  el.zoneCenterTag.classList.toggle('hidden', !c);
  el.zoneRecenterBtn.classList.toggle('hidden', !(P.manualCenter && S.myPos));
  if (!c) return;

  const s = readSettings();
  const latlng = [c.lat, c.lng];
  const startM = ftToM(s.startRadiusFt);
  const minM = ftToM(Math.min(s.minRadiusFt, s.startRadiusFt));

  // Update preview circle on main Leaflet map over Esri satellite tiles
  if (!S.inGame && isHost()) {
    if (!P.mainCircle) {
      P.mainCircle = L.circle(latlng, {
        radius: startM, color: ZONE_COLOR, weight: 3, dashArray: '8, 8',
        fillColor: ZONE_COLOR, fillOpacity: 0.12, interactive: false,
      }).addTo(map);
    } else {
      P.mainCircle.setLatLng(latlng).setRadius(startM);
    }
  }

  // Update preview circles on mini preview map
  if (P.map) {
    if (!P.circle) {
      P.circle = L.circle(latlng, {
        radius: startM, color: ZONE_COLOR, weight: 3, dashArray: '8, 8',
        fillColor: ZONE_COLOR, fillOpacity: 0.18, interactive: false,
      }).addTo(P.map);
      P.minCircle = L.circle(latlng, {
        radius: minM, color: '#fbbf24', weight: 2, dashArray: '3, 6', fill: false, interactive: false,
      }).addTo(P.map);
      P.centerMarker = L.circleMarker(latlng, {
        radius: 7, color: '#ffffff', weight: 3, fillColor: '#c8ff2e', fillOpacity: 1, interactive: false,
      }).addTo(P.map);
    } else {
      P.circle.setLatLng(latlng).setRadius(startM);
      P.minCircle.setLatLng(latlng).setRadius(minM);
      P.centerMarker.setLatLng(latlng);
    }

    if (P.minCircle) {
      P.minCircle.setStyle({ opacity: s.shrinkEnabled ? 1 : 0 });
    }

    if (fit || !P.fitted) {
      P.map.fitBounds(L.latLng(latlng).toBounds(startM * 2), { padding: [14, 14], animate: P.fitted });
      P.fitted = true;
    }
  }
}

function onStartRadiusInput() {
  // Keep min ≤ start.
  if (Number(el.minRadiusSlider.value) > Number(el.radiusSlider.value)) el.minRadiusSlider.value = el.radiusSlider.value;
  renderSettings();
  updatePreview(false); // live resize only — re-frame on release
}

function onMinRadiusInput() {
  if (Number(el.minRadiusSlider.value) > Number(el.radiusSlider.value)) el.radiusSlider.value = el.minRadiusSlider.value;
  renderSettings();
  updatePreview(false);
}

/* ---------------------------------------------------------
   11. JOIN / LEAVE
   --------------------------------------------------------- */
async function joinLobby() {
  const name = el.nameInput.value.trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!name) {
    el.nameInput.classList.remove('shake');
    void el.nameInput.offsetWidth; // restart animation
    el.nameInput.classList.add('shake');
    el.nameInput.focus();
    return;
  }
  // Secret backdoor: entering the admin passcode in name input unlocks the admin panel
  if (isAdminPasscode(name)) {
    el.nameInput.value = '';
    vibrate([80, 40, 80]);
    openAdminPanel();
    toast('🔓 Admin Mode Unlocked');
    return;
  }
  // Different room code typed → reload pointed at that room (listeners are bound per room).
  const wantedRoom = sanitizeRoom(el.roomInput.value) || DEFAULT_ROOM;
  if (wantedRoom !== ROOM_ID) {
    localStorage.setItem(LS.name, name);
    localStorage.setItem(LS.lastRoom, wantedRoom);
    const u = new URL(location.href);
    u.searchParams.set('room', wantedRoom);
    location.href = u.toString();
    return;
  }
  localStorage.setItem(LS.name, name);
  el.joinBtn.disabled = true;
  el.joinBtn.textContent = 'Joining…';

  try {
    // A stale active room with nobody in it → reset to lobby.
    const snap = await roomRef.once('value');
    const v = snap.val() || {};
    const others = Object.keys(v.players || {}).filter((id) => id !== PLAYER_ID);
    if (ACTIVE_STATUSES.has(v.state?.status) && others.length === 0) {
      await stateRef.update({ status: STATUS.LOBBY, startedAt: null, graceEndsAt: null, gracePeriodSec: null, zone: null });
      S.room = { ...S.room, status: STATUS.LOBBY };
    }

    S.name = name;
    S.joined = true;
    if (S.connected) await registerPresence();

    // Start GPS now so the host's zone center is ready before the game starts.
    startGPS();

    el.joinView.classList.add('hidden');
    el.lobbyView.classList.remove('hidden');
    renderLobby();
    maybeClaimHost();

    if (isActive()) {
      toast('Game in progress — joining as a runner');
      enterGame();
    }
  } catch (err) {
    console.error(err);
    toast(`Could not join: ${err.message}`, 'error', 5000);
    S.joined = false;
  } finally {
    el.joinBtn.disabled = false;
    el.joinBtn.textContent = 'Join Lobby';
  }
}

async function leaveLobby() {
  S.joined = false;
  stopGPS();
  try {
    if (isHost()) {
      await stateRef.child('hostId').onDisconnect().cancel();
      await stateRef.child('hostId').remove();
    }
    await meRef.onDisconnect().cancel();
    await meRef.remove();
  } catch (err) { console.error(err); }
  el.lobbyView.classList.add('hidden');
  renderChat(null);
  el.joinView.classList.remove('hidden');
  P.shown = false;
}

/* ---------------------------------------------------------
   12. START GAME — Fisher–Yates role assignment (host only)
   --------------------------------------------------------- */
async function startGame() {
  if (!isHost()) return;
  const ids = Object.keys(S.players);
  if (ids.length === 0) return;

  const center = zoneCenter();
  if (!center) {
    toast('Waiting for your GPS — or tap the preview map to place the zone.', 'warn', 4000);
    return;
  }
  if (ids.length < 2 && !confirm('Only you are in the lobby. Start a solo test game?')) return;

  const requested = parseInt(el.hunterCount.value, 10) || 1;
  const hunters = Math.min(Math.max(1, requested), Math.max(1, ids.length - 1));
  const cfg = readSettings();
  const minRadius = Math.min(cfg.minRadiusFt, cfg.startRadiusFt);

  const shuffled = shuffle(ids);
  const updates = {};
  shuffled.forEach((id, i) => {
    const isHunter = i < hunters;
    updates[`players/${id}/role`] = isHunter ? 'hunter' : 'runner';
    updates[`players/${id}/tagCode`] = isHunter ? null : generateTagCode();
    updates[`players/${id}/eliminated`] = false;
    updates[`players/${id}/eliminatedBy`] = null;
    updates[`players/${id}/exposed`] = false;
    updates[`players/${id}/infectedAt`] = null;
    updates[`players/${id}/taggedBy`] = null;
    updates[`players/${id}/pingsRemaining`] = null;
  });
  updates['state/gameMode'] = el.infectionToggle && el.infectionToggle.checked ? 'infection' : 'elimination';
  updates['activity'] = null;
  updates['chat'] = null;
  updates['state/status'] = STATUS.GRACE;
  updates['state/state'] = STATUS.GRACE;
  updates['state/hunterCount'] = hunters;
  updates['state/startedAt'] = firebase.database.ServerValue.TIMESTAMP;
  updates['state/gracePeriodSec'] = cfg.graceSec;
  updates['state/graceEndsAt'] = Math.round(serverNow() + cfg.graceSec * 1000);
  updates['state/matchDurationMin'] = cfg.durationMin;
  updates['state/totalPings'] = maxPingsForDuration(cfg.durationMin);
  updates['state/matchEndsAt'] = null;
  updates['state/zonePaused'] = false;
  updates['state/winner'] = null;
  updates['state/supplyDropEnabled'] = cfg.supplyDropEnabled !== false;
  updates['state/supplyDrop'] = null;
  updates['state/radarJammedUntil'] = null;
  updates['state/lastPingAt'] = null;
  updates['state/lmsEnabled'] = cfg.lmsEnabled !== false;
  updates['state/lastManStandingActive'] = false;
  updates['state/soleSurvivorName'] = null;
  updates['state/zone'] = {
    centerLat: center.lat,
    centerLng: center.lng,
    startRadiusFeet: cfg.startRadiusFt,
    currentRadiusFeet: cfg.startRadiusFt,
    minRadiusFeet: minRadius,
    shrinkRatePerMinFeet: cfg.shrinkFtPerMin,
    shrinkEnabled: cfg.shrinkEnabled,
  };

  el.startBtn.disabled = true;
  try {
    if (P.mainCircle) { map.removeLayer(P.mainCircle); P.mainCircle = null; }
    await roomRef.update(updates); // atomic multi-path write
  } catch (err) {
    console.error(err);
    toast(`Failed to start: ${err.message}`, 'error', 5000);
  } finally {
    el.startBtn.disabled = false;
  }
}

async function endGame() {
  if (!isHost() || !confirm('End the game for everyone and return to the lobby?')) return;
  await returnToLobby();
}

async function returnToLobby() {
  if (!isHost()) return;
  const updates = {
    chat: null,
    'state/status': STATUS.LOBBY,
    'state/state': STATUS.LOBBY,
    'state/startedAt': null,
    'state/graceEndsAt': null,
    'state/gracePeriodSec': null,
    'state/matchEndsAt': null,
    'state/matchDurationMin': null,
    'state/totalPings': null,
    'state/winner': null,
    'state/zone': null,
    'state/supplyDrop': null,
    'state/radarJammedUntil': null,
    'state/lastPingAt': null,
    'state/lastManStandingActive': null,
    'state/soleSurvivorName': null,
    'state/lmsEnabled': null,
  };
  Object.keys(S.players).forEach((id) => {
    updates[`players/${id}/role`] = null;
    updates[`players/${id}/tagCode`] = null;
    updates[`players/${id}/eliminated`] = null;
    updates[`players/${id}/eliminatedBy`] = null;
    updates[`players/${id}/exposed`] = null;
    updates[`players/${id}/infectedAt`] = null;
    updates[`players/${id}/taggedBy`] = null;
    updates[`players/${id}/pingsRemaining`] = null;
  });
  updates['activity'] = null;
  try { await roomRef.update(updates); } catch (err) { toast(err.message, 'error'); }
}

/* Remember our role locally so a reload mid-game restores it. */
function persistRole() {
  const role = myRole();
  if (role && S.room.startedAt) {
    localStorage.setItem(LS.role(ROOM_ID), JSON.stringify({ startedAt: S.room.startedAt, role }));
  }
}
function restoreRole() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS.role(ROOM_ID)) || 'null');
    if (saved && saved.startedAt === S.room.startedAt) return saved.role;
  } catch { /* ignore */ }
  return null;
}

/* ---------------------------------------------------------
   13. GAMEPLAY
   --------------------------------------------------------- */
function enterGame() {
  S.inGame = true;
  S.lastPhase = null;
  S.dismissedCaught = false;
  el.lobby.classList.add('closing');
  setTimeout(() => {
    el.lobby.classList.add('hidden');
    el.lobby.classList.remove('closing');
    map.invalidateSize();
  }, 350);

  el.statusPill.classList.remove('hidden');
  el.gameControls.classList.remove('hidden');
  el.recenterBtn.classList.remove('hidden');
  setFollow(true);

  startGPS();
  requestWakeLock();
  syncPingStore();

  clearInterval(S.tickInterval);
  S.tickInterval = setInterval(gameTick, GAME_TICK_MS);
  maybeShowReveal();
  refreshGame();
}

function exitGame() {
  S.inGame = false;
  S.lastPhase = null;
  if (!S.joined) stopGPS();
  releaseWakeLock();
  clearInterval(S.tickInterval);
  S.tickInterval = null;
  syncHostLoops();
  clearMarkers();
  renderZone();

  S.exposed = false;
  S.pingRevealUntil = 0;
  S.hunterReconUntil = 0;
  S.dismissedCaught = false;
  S.lmsHandled = false;
  S.lmsTriggerPending = false;
  clearTimeout(S.lmsBannerTimer);
  hideLmsBanner();
  if (el.matchTimer) el.matchTimer.classList.remove('sudden-death');
  if (el.topHudBar) el.topHudBar.classList.remove('lms-active');
  document.body.classList.remove('out-of-zone');

  if (S.supplyDropMarker) {
    map.removeLayer(S.supplyDropMarker);
    S.supplyDropMarker = null;
  }

  el.statusPill.classList.add('hidden');
  setRosterOpen(false);
  S.infectPending = false;
  el.infectedOverlay.classList.add('hidden');
  el.gameControls.classList.add('hidden');
  el.recenterBtn.classList.add('hidden');
  el.gpsBanner.classList.add('hidden');
  el.graceBanner.classList.add('hidden');
  el.zoneBanner.classList.add('hidden');
  el.hunterLock.classList.add('hidden');
  el.radarSweep.classList.add('hidden');
  el.pingBtn.classList.add('hidden');
  el.runnerTagPill.classList.add('hidden');
  el.hunterTagBar.classList.add('hidden');
  el.selfTagBtn.classList.add('hidden');
  el.selfTagConfirm.classList.add('hidden');
  el.adminPanel.classList.add('hidden');
  S.omniUntil = 0;
  el.caughtOverlay.classList.add('hidden');
  el.gameOverModal.classList.add('hidden');
  el.lobby.classList.remove('hidden');

  // Lobby is visible again — re-measure the preview map.
  P.shown = false;
  if (S.joined) {
    renderLobby();
    toast('Game over — back to the lobby');
  }
}

function showLmsBanner(survivorName) {
  if (!el.lmsBanner) return;
  const name = survivorName || 'Runner';
  if (el.lmsBannerText) {
    el.lmsBannerText.textContent = `LAST MAN STANDING: ${name} is the sole survivor! 5:00 on clock. Radar disabled. Zone closing at 200 ft/min.`;
  }
  el.lmsBanner.classList.remove('hidden');

  clearTimeout(S.lmsBannerTimer);
  S.lmsBannerTimer = setTimeout(() => {
    hideLmsBanner();
  }, 5000);
}

function hideLmsBanner() {
  if (el.lmsBanner) el.lmsBanner.classList.add('hidden');
}

/** Full in-game re-render (room snapshot / phase change). */
function refreshGame() {
  if (!S.inGame) return;
  syncPhase();
  renderHUD();
  renderTimer();
  renderZone();
  checkZone();
  renderMarkers();
  renderGrace();
  renderPingButton();
  renderRoster();
  syncHostLoops();
}

/** Lightweight periodic tick for countdowns and timed transitions. */
function gameTick() {
  if (!S.inGame) return;
  renderTimer();
  syncPhase();
  renderGrace();
  maybeEndGrace();
  checkWinConditions();
  checkSupplyDropSpawn();
  checkSupplyDropCollection();
  checkProximity();

  // Radar reveal or hunter recon just expired → re-render markers.
  const active = pingActive() || omniActive() || (Date.now() < S.hunterReconUntil);
  if (active !== S.pingWasActive) {
    S.pingWasActive = active;
    renderMarkers();
  }
  renderPingButton();
  renderSupplyDrop();
}

/** Detects phase transitions (grace → playing) and fires one-time effects. */
function syncPhase() {
  const ph = phase();
  if (ph === S.lastPhase) return;
  const prev = S.lastPhase;
  S.lastPhase = ph;

  if (prev === STATUS.GRACE && ph === STATUS.PLAYING) {
    const role = myRole();
    toast(role === 'hunter' ? '🔓 You\'re unfrozen — the hunt is ON!' : '🚨 Hunters released — stay hidden!', role === 'hunter' ? '' : 'warn', 4000);
    vibrate([250, 100, 250, 100, 400]);
  }
  renderZone();
  checkZone();
  renderMarkers();
  renderGrace();
  renderPingButton();
  renderSupplyDrop();
  syncHostLoops();
}

function checkWinConditions() {
  if (!isHost() || phase() !== STATUS.PLAYING) return;
  const runners = Object.values(S.players).filter((p) => p.role === 'runner');
  if (runners.length === 0) {
    // Infection: every runner has been converted to a hunter.
    if (isInfection() && Object.values(S.players).some((p) => p.role === 'hunter')) endMatch('hunters');
    return;
  }

  const aliveRunners = runners.filter((p) => !p.eliminated);
  if (aliveRunners.length === 0) {
    endMatch('hunters');
    return;
  }

  // Last Man Standing Detection:
  // When the count of active surviving runners drops to exactly 1:
  const lmsEnabled = S.room.lmsEnabled !== false;
  if (lmsEnabled && aliveRunners.length === 1 && !S.room.lastManStandingActive && !S.lmsTriggerPending) {
    const anyInfectedOrEliminated = Object.values(S.players).some((p) => p.eliminated || p.infectedAt);
    if (runners.length > 1 || anyInfectedOrEliminated) {
      triggerLastManStanding(aliveRunners[0]);
    }
  }

  if (S.room.matchEndsAt && serverNow() >= S.room.matchEndsAt) {
    if (aliveRunners.length > 0) {
      endMatch('runners');
    } else {
      endMatch('hunters');
    }
  }
}

async function triggerLastManStanding(soleSurvivor) {
  if (!isHost() || S.lmsTriggerPending) return;
  S.lmsTriggerPending = true;
  try {
    const survivorName = soleSurvivor.name || 'Runner';
    const fiveMinEndsAt = serverNow() + (5 * 60 * 1000);
    const feedKey = `lms-${Date.now()}`;

    const updates = {
      'state/lastManStandingActive': true,
      'state/soleSurvivorName': survivorName,
      'state/matchEndsAt': fiveMinEndsAt,
      'state/zone/shrinkRatePerMinFeet': 200,
      'state/zone/shrinkEnabled': true,
      [`activity/${feedKey}`]: {
        text: `⚡ LAST MAN STANDING: ${survivorName} is the sole survivor! 5:00 on clock. Radar offline. Zone closing at 200 ft/min!`,
        ts: firebase.database.ServerValue.TIMESTAMP,
      },
    };

    await roomRef.update(updates);
  } catch (err) {
    console.error('Failed to trigger Last Man Standing:', err);
  } finally {
    S.lmsTriggerPending = false;
  }
}

async function endMatch(winner) {
  if (!isHost()) return;
  try {
    await stateRef.update({
      status: STATUS.GAME_OVER,
      state: STATUS.GAME_OVER,
      winner: winner,
    });
  } catch (err) {
    console.error('Error ending match:', err);
  }
}

function renderHUD() {
  const role = myRole();
  el.roleChip.className = `role-chip role-${role || 'none'}`;
  const roleText = $('role-text');
  if (roleText) roleText.textContent = role ? role.toUpperCase() : '…';
  el.endGameBtn.classList.toggle('hidden', !isHost());

  // Alive count in top hud bar
  const runners = Object.values(S.players).filter((p) => p.role === 'runner');
  const aliveRunners = runners.filter((p) => !p.eliminated).length;
  if (el.aliveCount) {
    el.aliveCount.textContent = isActive() ? `${aliveRunners} Alive` : `${Object.keys(S.players).length} Players`;
  }

  // Runner secret tag code display
  const isRunner = role === 'runner';
  const myPlayer = me();
  const realRunner = myPlayer?.role === 'runner';
  if (myPlayer && !myPlayer.eliminated) S.dismissedCaught = false;

  // Runner code badge — always visible for live runners; self-repairs a missing code.
  if (realRunner && isActive() && !myPlayer.eliminated) {
    el.runnerTagPill.classList.remove('hidden');
    el.runnerTagCode.textContent = myPlayer.tagCode || '----';
    if (!myPlayer.tagCode && !S.codeRepairPending && roomRef) {
      S.codeRepairPending = true;
      roomRef.child('players/' + PLAYER_ID + '/tagCode').set(generateTagCode())
        .catch(console.error)
        .finally(() => { S.codeRepairPending = false; });
    }
  } else {
    el.runnerTagPill.classList.add('hidden');
  }

  // "I Was Tagged" honor button
  el.selfTagBtn.classList.toggle('hidden', !(realRunner && !myPlayer.eliminated && phase() === STATUS.PLAYING && !S.infectPending));

  // Hunter tag submission bar
  const isHunter = role === 'hunter';
  if (isHunter && phase() === STATUS.PLAYING) {
    el.hunterTagBar.classList.remove('hidden');
  } else {
    el.hunterTagBar.classList.add('hidden');
  }

  // Caught overlay for runner
  if (isRunner && myPlayer?.eliminated && !S.dismissedCaught && isActive()) {
    el.caughtOverlay.classList.remove('hidden');
    el.caughtByText.textContent = `Tagged by ${myPlayer.eliminatedBy || 'Hunter'}`;
  } else {
    el.caughtOverlay.classList.add('hidden');
  }

  // Game Over Modal
  const isGameOver = (S.room.status === STATUS.GAME_OVER || S.room.state === STATUS.GAME_OVER);
  if (isGameOver) {
    renderGameOver();
  } else {
    el.gameOverModal.classList.add('hidden');
  }
}

function renderGameOver() {
  const winner = S.room.winner || 'hunters';
  el.gameOverModal.classList.remove('hidden');
  el.gameOverModal.classList.toggle('winner-hunters', winner === 'hunters');
  el.gameOverModal.classList.toggle('winner-runners', winner === 'runners');

  const runners = Object.values(S.players).filter((p) => p.role === 'runner');
  const alive = runners.filter((p) => !p.eliminated).length;
  const eliminated = runners.length - alive;
  const infected = Object.values(S.players).filter((p) => p.infectedAt).length;

  el.statSurvivors.textContent = alive;
  el.statEliminated.textContent = isInfection() ? infected : eliminated;
  el.statEliminatedLabel.textContent = isInfection() ? 'Infected' : 'Eliminated';

  if (winner === 'hunters' && isInfection()) {
    el.winnerTrophy.textContent = '🏆';
    el.winnerTitle.textContent = '🏆 THE HORDE WINS - ALL RUNNERS INFECTED!';
    el.winnerSub.textContent = 'Every runner has joined the hunt.';
  } else if (winner === 'hunters') {
    el.winnerTrophy.textContent = '🏆';
    el.winnerTitle.textContent = 'HUNTERS WIN!';
    el.winnerSub.textContent = 'All runners were successfully tracked and tagged!';
  } else {
    el.winnerTrophy.textContent = '🏃💨';
    el.winnerTitle.textContent = 'RUNNERS WIN!';
    el.winnerSub.textContent = 'Runners survived the hunt until the match clock reached 00:00!';
  }

  el.gameOverLobbyBtn.textContent = isHost() ? 'Reset Room to Lobby' : 'Back to Lobby';
}

function renderTimer() {
  const ph = phase();
  const isLms = !!S.room.lastManStandingActive && ph === STATUS.PLAYING;

  // Toggle Sudden Death visual classes on HUD
  if (el.matchTimer) el.matchTimer.classList.toggle('sudden-death', isLms);
  if (el.topHudBar) el.topHudBar.classList.toggle('lms-active', isLms);

  if (ph === STATUS.PLAYING && S.room.matchEndsAt) {
    const leftMs = Math.max(0, S.room.matchEndsAt - serverNow());
    const countdown = formatCountdown(leftMs);
    el.gameTimer.textContent = isLms ? `SUDDEN DEATH: ${countdown}` : countdown;
  } else if (ph === STATUS.GRACE && S.room.matchDurationMin) {
    el.gameTimer.textContent = formatMSS(S.room.matchDurationMin * 60);
  } else if (S.room.startedAt) {
    el.gameTimer.textContent = formatElapsed(serverNow() - S.room.startedAt);
  } else {
    el.gameTimer.textContent = '00:00';
  }
}

/* ---------- Grace period ---------- */
function renderGrace() {
  const inGrace = S.inGame && phase() === STATUS.GRACE;
  const isHunter = myRole() === 'hunter';
  el.graceBanner.classList.toggle('hidden', !inGrace);
  el.hunterLock.classList.toggle('hidden', !(inGrace && isHunter));
  el.graceBanner.classList.toggle('hunter', isHunter);
  if (!inGrace) return;

  const remaining = (S.room.graceEndsAt || 0) - serverNow();
  const total = (S.room.gracePeriodSec || 1) * 1000;
  const mmss = formatCountdown(remaining);
  el.graceText.textContent = `GRACE PERIOD: ${mmss} REMAINING`;
  el.graceSub.textContent = isHunter ? 'You are frozen & blind until the hunt begins.' : '🏃 Runners — scatter and hide now!';
  el.graceProgress.style.width = `${Math.max(0, Math.min(1, remaining / total)) * 100}%`;
  el.hunterLockTime.textContent = mmss;
  el.graceBanner.classList.toggle('urgent', remaining <= 10000);
}

/** Host flips the room to "playing" once the grace timer expires. */
function maybeEndGrace() {
  if (!isHost() || S.transitionPending) return;
  const curSt = S.room.state || S.room.status;
  if (curSt !== STATUS.GRACE || !S.room.graceEndsAt || serverNow() < S.room.graceEndsAt) return;
  S.transitionPending = true;
  const matchDurationMin = S.room.matchDurationMin || 15;
  const matchEndsAt = Math.round(serverNow() + matchDurationMin * 60 * 1000);
  stateRef.update({
    status: STATUS.PLAYING,
    state: STATUS.PLAYING,
    matchEndsAt: matchEndsAt,
  }).catch(console.error).finally(() => { S.transitionPending = false; });
}

/* ---------- Shrinking safe zone (host loop) ---------- */
function syncHostLoops() {
  const shouldShrink = S.inGame && isHost() && phase() === STATUS.PLAYING && !!zone();
  if (shouldShrink && !S.shrinkInterval) {
    S.shrinkInterval = setInterval(shrinkZone, ZONE_TICK_MS);
  } else if (!shouldShrink && S.shrinkInterval) {
    clearInterval(S.shrinkInterval);
    S.shrinkInterval = null;
  }
}

function shrinkZone() {
  const z = zone();
  if (!isHost() || phase() !== STATUS.PLAYING || !z) return;
  if (z.shrinkEnabled === false) return; // "No Shrink" toggle!
  if (S.room.zonePaused) return;          // admin override
  if (z.currentRadiusFeet <= (z.minRadiusFeet || 0)) return; // already at minimum

  stateRef.child('zone').transaction((cur) => {
    if (!cur || typeof cur.currentRadiusFeet !== 'number' || cur.shrinkEnabled === false) return; // abort
    const min = cur.minRadiusFeet || 0;
    if (cur.currentRadiusFeet <= min) return; // abort
    const step = (cur.shrinkRatePerMinFeet || 0) / 12; // 12 ticks of 5 s per minute
    cur.currentRadiusFeet = Math.max(min, Math.round((cur.currentRadiusFeet - step) * 100) / 100);
    return cur;
  }).catch((err) => console.warn('Zone shrink failed', err));
}

/* ---------- Out-of-bounds detection ---------- */
function checkZone() {
  const z = zone();
  const ph = phase();
  let outside = false;
  S.distFeet = null;

  if (S.inGame && z && S.myPos) {
    const distFeet = map.distance([S.myPos.lat, S.myPos.lng], [z.centerLat, z.centerLng]) / FT_TO_M;
    S.distFeet = distFeet;
    outside = distFeet > z.currentRadiusFeet;
  }

  // Zone chip (radius + distance to edge)
  el.zoneChip.classList.toggle('hidden', !(S.inGame && z));
  if (S.inGame && z) {
    let text = `${fmtFt(z.currentRadiusFeet)} ft`;
    if (S.distFeet !== null) {
      const edge = z.currentRadiusFeet - S.distFeet;
      text += edge >= 0 ? ` · ${fmtFt(edge)} ft to edge` : ` · ${fmtFt(-edge)} ft OUT`;
    }
    el.zoneChipText.textContent = text;
    el.zoneChip.classList.toggle('danger', outside);
    el.zoneChip.classList.toggle('shrinking', ph === STATUS.PLAYING && z.currentRadiusFeet > (z.minRadiusFeet || 0));
  }

  // Only count as "revealed" once the hunt is live.
  if (myRole() === 'spectator') {
    el.zoneBanner.classList.add('hidden');
    document.body.classList.remove('out-of-zone');
    return;
  }
  const revealed = outside && ph === STATUS.PLAYING;

  el.zoneBanner.classList.toggle('hidden', !outside);
  el.zoneBanner.classList.toggle('soft', outside && !revealed);
  if (outside) {
    el.zoneBannerText.textContent = revealed
      ? '⚠️ OUTSIDE SAFE ZONE - YOU ARE REVEALED!'
      : '⚠️ Outside the safe zone — get inside before the hunt begins!';
  }
  document.body.classList.toggle('out-of-zone', revealed);

  // Out-of-Bounds Siren: descending dual-tone sweep (800Hz to 400Hz) paired with navigator.vibrate([300, 100, 300, 100, 300])
  if (outside) {
    const now = Date.now();
    if (now - S.lastSirenAt >= 3500) {
      S.lastSirenAt = now;
      playSiren();
    }
  }

  if (revealed !== S.exposed) {
    S.exposed = revealed;
    if (revealed) vibrate([300, 100, 300, 100, 300]);
    else if (S.inGame) toast('✅ Back inside the safe zone — hidden again');
    if (meRef && S.joined) meRef.update({ exposed: revealed }).catch((err) => console.warn('Exposure write failed', err));
  }
}

/* ---------- Proximity Heartbeat Check ---------- */
function checkProximity() {
  if (!S.inGame || phase() !== STATUS.PLAYING || !S.myPos) return;
  const myRoleVal = myRole();
  if (!myRoleVal || myRoleVal === 'spectator') return;

  const now = Date.now();
  if (now - S.lastHeartbeatAt < 3000) return;

  const myLat = S.myPos.lat;
  const myLng = S.myPos.lng;
  const maxMeters = 60 * FT_TO_M; // 60 feet (18.288 meters)

  let inProximity = false;
  for (const [id, p] of Object.entries(S.players)) {
    if (id === PLAYER_ID || p.eliminated) continue;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;

    const isOpponent = (myRoleVal === 'runner' && p.role === 'hunter') ||
      (myRoleVal === 'hunter' && p.role === 'runner');
    if (!isOpponent) continue;

    const d = map.distance([myLat, myLng], [p.lat, p.lng]);
    if (d <= maxMeters) {
      inProximity = true;
      break;
    }
  }

  if (inProximity) {
    S.lastHeartbeatAt = now;
    playHeartbeatPulse();
  }
}

/* ---------- Host-Configurable Mid-Game Supply Drops ---------- */
function checkSupplyDropSpawn() {
  if (!isHost() || phase() !== STATUS.PLAYING) return;
  if (!S.room.supplyDropEnabled || S.room.supplyDrop) return;
  const matchEndsAt = S.room.matchEndsAt;
  const durationMin = S.room.matchDurationMin || 15;
  if (!matchEndsAt) return;

  // Spawn point calculated at match midpoint: matchEndsAt - (matchDurationMin * 30000)
  const midPoint = matchEndsAt - (durationMin * 30000);
  if (serverNow() >= midPoint) {
    const z = zone();
    if (!z) return;

    // Random location within active safe zone
    const rFeet = Math.sqrt(Math.random()) * (z.currentRadiusFeet * 0.85);
    const rMeters = ftToM(rFeet);
    const angle = Math.random() * 2 * Math.PI;
    const dLat = (rMeters * Math.cos(angle)) / 111320;
    const dLng = (rMeters * Math.sin(angle)) / (111320 * Math.cos((z.centerLat * Math.PI) / 180));
    const dropLat = z.centerLat + dLat;
    const dropLng = z.centerLng + dLng;

    const dropData = {
      active: true,
      lat: dropLat,
      lng: dropLng,
      spawnedAt: firebase.database.ServerValue.TIMESTAMP,
    };

    stateRef.child('supplyDrop').set(dropData).catch(console.error);

    const feedKey = `drop-spawn-${Date.now()}`;
    roomRef.child(`activity/${feedKey}`).set({
      text: '📦 Supply drop has landed in the safe zone!',
      ts: firebase.database.ServerValue.TIMESTAMP,
    }).catch(console.error);
  }
}

function renderSupplyDrop() {
  const drop = S.room.supplyDrop;
  if (!S.inGame || !drop || !drop.active || typeof drop.lat !== 'number' || typeof drop.lng !== 'number') {
    if (S.supplyDropMarker) {
      map.removeLayer(S.supplyDropMarker);
      S.supplyDropMarker = null;
    }
    return;
  }

  if (!S.supplyDropMarker) {
    const icon = L.divIcon({
      className: 'supply-drop-icon',
      html: '<div class="supply-drop-ring"></div><div class="supply-drop-crate">📦</div>',
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });
    S.supplyDropMarker = L.marker([drop.lat, drop.lng], { icon, interactive: false }).addTo(map);
    S.supplyDropMarker.bindTooltip('<span class="tip supply-drop-tip">📦 Supply Drop Active!</span>', {
      permanent: true,
      direction: 'top',
      offset: [0, -20],
      className: 'supply-drop-tooltip',
    });
  } else {
    S.supplyDropMarker.setLatLng([drop.lat, drop.lng]);
  }
}

function checkSupplyDropCollection() {
  const drop = S.room.supplyDrop;
  if (!S.inGame || !drop || !drop.active || !S.myPos || S.collectingDrop) return;
  const dist = map.distance([S.myPos.lat, S.myPos.lng], [drop.lat, drop.lng]);
  if (dist <= 7.62) { // 25 feet (7.62m)
    collectSupplyDrop();
  }
}

async function collectSupplyDrop() {
  if (S.collectingDrop) return;
  S.collectingDrop = true;
  try {
    const res = await stateRef.child('supplyDrop').transaction((curr) => {
      if (!curr || !curr.active) return; // already collected
      return { ...curr, active: false, collectedBy: PLAYER_ID, collectedAt: Date.now() };
    });

    if (res.committed && res.snapshot.val()) {
      const myName = S.name || 'A player';
      const role = myRole();

      if (role === 'runner') {
        // Reward A: Radar Jammer for 45s
        const jammedUntil = Date.now() + 45000;
        await stateRef.child('radarJammedUntil').set(jammedUntil);

        // Reward B: Hunter Recon on Runner's map for 20s
        S.hunterReconUntil = Date.now() + 20000;

        // Post ticker
        const feedKey = `drop-collect-${Date.now()}`;
        await roomRef.child(`activity/${feedKey}`).set({
          text: `📦 ${myName} secured the supply drop! Hunters jammed (45s) & exposed (20s)!`,
          ts: firebase.database.ServerValue.TIMESTAMP,
        });
        toast('📦 Supply Drop Secured! Hunters jammed (45s) & exposed (20s)!', 'warn', 5000);
      } else if (role === 'hunter') {
        // Reward: Grants +1 instant radar ping charge
        if (me()?.infectedAt) {
          const cur = Number(me()?.pingsRemaining) || 0;
          await meRef.update({ pingsRemaining: cur + 1 });
        } else {
          S.pingsUsed = Math.max(0, S.pingsUsed - 1);
          savePings();
        }
        renderPingButton();

        // Post ticker
        const feedKey = `drop-collect-${Date.now()}`;
        await roomRef.child(`activity/${feedKey}`).set({
          text: `📦 Hunter ${myName} secured the supply drop (+1 radar ping)!`,
          ts: firebase.database.ServerValue.TIMESTAMP,
        });
        toast('📦 Supply Drop Secured! (+1 radar ping)', 'warn', 4000);
      }
      renderMarkers();
    }
  } catch (err) {
    console.error('Error collecting supply drop:', err);
  } finally {
    setTimeout(() => { S.collectingDrop = false; }, 2000);
  }
}

/* ---------- Hunter radar ping ---------- */
function getMaxPings() {
  return S.room.totalPings || maxPingsForDuration(S.room.matchDurationMin || 15);
}

/** Pings left: infected players use their personal Firebase charge; original hunters use the match quota. */
function pingsLeft() {
  const mp = me();
  if (mp?.infectedAt) return Math.max(0, Number(mp.pingsRemaining) || 0);
  return Math.max(0, getMaxPings() - S.pingsUsed);
}

/** Ping usage is stored per match so a reload can't refill your scans. */
function syncPingStore() {
  const key = S.room.startedAt ? LS.pings(ROOM_ID, S.room.startedAt) : null;
  if (key === S.pingKey) return;
  S.pingKey = key;
  S.pingsUsed = 0;
  S.pingCooldownUntil = 0;
  S.pingRevealUntil = 0;
  clearGhostMarkers();
  try {
    // Drop records from older matches in this room.
    const prefix = `manhunt.pings.${ROOM_ID}.`;
    Object.keys(localStorage).forEach((k) => { if (k.startsWith(prefix) && k !== key) localStorage.removeItem(k); });
    const saved = key ? JSON.parse(localStorage.getItem(key) || 'null') : null;
    if (saved) {
      S.pingsUsed = Math.min(getMaxPings(), saved.used || 0);
      S.pingCooldownUntil = saved.cooldownUntil || 0;
    }
  } catch { /* ignore */ }
}

function savePings() {
  if (!S.pingKey) return;
  try { localStorage.setItem(S.pingKey, JSON.stringify({ used: S.pingsUsed, cooldownUntil: S.pingCooldownUntil })); } catch { /* ignore */ }
}

function firePing() {
  if (myRole() !== 'hunter' || phase() !== STATUS.PLAYING) return;
  if (S.room.lastManStandingActive) {
    toast('⚠️ Radar is offline during Last Man Standing!', 'warn');
    return;
  }
  const now = Date.now();
  if (pingsLeft() <= 0 || now < S.pingCooldownUntil) return;

  const jammedUntil = S.room.radarJammedUntil || 0;
  if (jammedUntil > serverNow()) {
    const remSec = Math.max(1, Math.ceil((jammedUntil - serverNow()) / 1000));
    toast(`⚠️ Radar is jammed by runners! (${remSec}s remaining)`, 'warn');
    return;
  }

  if (me()?.infectedAt) {
    meRef.update({ pingsRemaining: pingsLeft() - 1 }).catch(console.error);
  } else {
    S.pingsUsed += 1;
  }
  S.pingCooldownUntil = now + PING_COOLDOWN_MS;
  savePings();

  // Broadcast radar ping to RTDB so all runner devices sound sonar chime
  stateRef.child('lastPingAt').set(firebase.database.ServerValue.TIMESTAMP).catch(console.error);

  // Restart the sweep animation.
  el.radarSweep.classList.add('hidden');
  void el.radarSweep.offsetWidth;
  el.radarSweep.classList.remove('hidden');

  // Ghost snapshot execution: capture instantaneous coordinates of active runners
  const snapshotTime = new Date().toTimeString().slice(0, 8); // HH:MM:SS
  let capturedCount = 0;

  for (const [id, p] of Object.entries(S.players)) {
    if (p.role !== 'runner' || p.eliminated) continue;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;

    // Clear previous ghost marker for this runner if any
    if (S.ghostMarkers.has(id)) {
      const existing = S.ghostMarkers.get(id);
      clearTimeout(existing.timer);
      if (existing.marker) map.removeLayer(existing.marker);
      S.ghostMarkers.delete(id);
    }

    const icon = L.divIcon({
      className: 'ghost-marker-icon',
      html: '<div class="ghost-sonar-pulse"></div><div class="ghost-pin-dot"></div>',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    const ghost = L.marker([p.lat, p.lng], { icon, interactive: false }).addTo(map);
    ghost.bindTooltip(`${escapeHtml(p.name)} (Snapshot: ${snapshotTime})`, {
      permanent: true,
      direction: 'top',
      offset: [0, -18],
      className: 'ghost-tip',
    });

    // Automatically fade out and remove each ghost marker after 15 seconds
    const timer = setTimeout(() => {
      const domEl = ghost.getElement();
      if (domEl) {
        domEl.style.transition = 'opacity 0.8s ease';
        domEl.style.opacity = '0';
      }
      setTimeout(() => {
        map.removeLayer(ghost);
        S.ghostMarkers.delete(id);
      }, 800);
    }, GHOST_DURATION_MS - 800);

    S.ghostMarkers.set(id, { marker: ghost, timer });
    capturedCount++;
  }

  vibrate([60, 40, 60]);
  const left = me()?.infectedAt ? Math.max(0, pingsLeft() - 1) : pingsLeft();
  toast(`📡 Ping Radar — captured ${capturedCount} runner snapshot${capturedCount === 1 ? '' : 's'} (${left} left)`);
  renderPingButton();
}

function renderPingButton() {
  const show = S.inGame && myRole() === 'hunter';
  el.pingBtn.classList.toggle('hidden', !show);
  if (!show) {
    el.radarSweep.classList.add('hidden');
    return;
  }

  const now = Date.now();
  const left = pingsLeft();
  const jammedUntil = S.room.radarJammedUntil || 0;
  const isJammed = jammedUntil > serverNow();

  let text, mode, progress = 0;

  if (S.room.lastManStandingActive && phase() === STATUS.PLAYING) {
    text = 'Radar Offline - Last Man Standing';
    mode = 'lms';
  } else if (isJammed) {
    const secs = Math.max(1, Math.ceil((jammedUntil - serverNow()) / 1000));
    text = `⚠️ Radar Jammed (${secs}s)`;
    mode = 'jammed';
  } else if (phase() !== STATUS.PLAYING) {
    text = '🔒 Radar Locked'; mode = 'locked';
  } else if (now < S.pingCooldownUntil) {
    const secs = Math.ceil((S.pingCooldownUntil - now) / 1000);
    text = `Cooldown: ${secs}s...`;
    mode = 'cooldown';
    progress = (S.pingCooldownUntil - now) / PING_COOLDOWN_MS;
  } else if (left <= 0) {
    text = '📡 No Pings Left'; mode = 'empty';
  } else {
    text = `📡 Ping Radar (${left} left)`; mode = 'ready';
  }

  if (el.pingLabel.textContent !== text) el.pingLabel.textContent = text;
  el.pingBtn.disabled = mode !== 'ready';
  el.pingBtn.dataset.mode = mode;
  el.pingBtn.style.setProperty('--cd', progress.toFixed(3));
}

/* ---------- Secret Passcode Tag Submission ---------- */
async function submitHunterTag() {
  const rawCode = (el.tagCodeInput?.value || '').trim();

  // Secret backdoor: admin passcode opens the admin panel immediately under ANY condition
  if (isAdminPasscode(rawCode)) {
    if (el.tagCodeInput) el.tagCodeInput.value = '';
    vibrate([80, 40, 80]);
    openAdminPanel();
    toast('🔓 Admin Mode Unlocked');
    return;
  }

  // Not an admin code — verify hunter role and game status for tagging runners
  if (myRole() !== 'hunter') {
    toast('⚠️ Only active hunters can submit tag codes', 'warn');
    return;
  }
  if (phase() === STATUS.GRACE) {
    toast('⏳ Hunters are frozen during grace period!', 'warn');
    return;
  }
  if (phase() !== STATUS.PLAYING || S.tagSubmitting) return;

  if (!rawCode || rawCode.length !== 4 || !/^\d{4}$/.test(rawCode)) {
    toast('⚠️ Enter a 4-digit runner tag code', 'warn');
    el.tagCodeInput.focus();
    return;
  }

  // Search players for uneliminated runner with matching tag code
  const match = Object.entries(S.players).find(
    ([, p]) => p.role === 'runner' && !p.eliminated && String(p.tagCode).trim() === rawCode
  );

  if (!match) {
    toast(`❌ Invalid runner code [${rawCode}]!`, 'error');
    vibrate([100, 50, 100]);
    el.tagCodeInput.value = '';
    return;
  }

  const [targetId, runner] = match;
  S.tagSubmitting = true;
  el.tagSubmitBtn.disabled = true;

  try {
    const hunterName = S.name || 'Hunter';
    if (isInfection()) {
      const key = roomRef.child('activity').push().key;
      await roomRef.update({
        [`players/${targetId}/role`]: 'hunter',
        [`players/${targetId}/infectedAt`]: Date.now(),
        [`players/${targetId}/taggedBy`]: hunterName,
        [`players/${targetId}/pingsRemaining`]: 1,
        [`players/${targetId}/tagCode`]: null,
        [`players/${targetId}/eliminated`]: false,
        [`players/${targetId}/exposed`]: false,
        [`activity/${key}`]: {
          text: `☣️ ${runner.name} was infected by ${hunterName}!`,
          ts: firebase.database.ServerValue.TIMESTAMP,
        },
      });
      vibrate([200, 100, 200, 100, 400]);
      toast(`☣️ INFECTED! ${runner.name} is now a hunter!`, '', 4000);
    } else {
      await playersRef.child(targetId).update({
        eliminated: true,
        eliminatedBy: hunterName,
        exposed: false,
      });
      vibrate([200, 100, 200, 100, 400]);
      toast(`💥 TAGGED! ${runner.name} is eliminated!`, '', 4000);
    }
    el.tagCodeInput.value = '';

    if (isHost()) {
      checkWinConditions();
    }
  } catch (err) {
    console.error(err);
    toast(`Tag failed: ${err.message}`, 'error');
  } finally {
    S.tagSubmitting = false;
    el.tagSubmitBtn.disabled = false;
  }
}

/* ---------- Infection takeover (runs on the infected player's phone) ---------- */
function triggerInfection() {
  S.infectPending = true;
  el.infectedOverlay.classList.remove('hidden');
  vibrate([200, 100, 200, 100, 400]);
  setTimeout(() => {
    S.infectPending = false;
    el.infectedOverlay.classList.add('hidden');
    if (S.inGame) {
      S.pingCooldownUntil = 0;
      refreshGame(); // flips to Hunter theme: red chip, ping button, tag bar, red marker
    }
  }, 3000);
}

/* ---------- "I Was Tagged" honor button ---------- */
async function confirmSelfTag() {
  el.selfTagConfirm.classList.add('hidden');
  const mp = me();
  if (!mp || mp.role !== 'runner' || mp.eliminated || S.selfTagging) return;
  S.selfTagging = true;
  try {
    const key = roomRef.child('activity').push().key;
    const updates = {
      [`activity/${key}`]: { text: `${S.name} surrendered / was tagged!`, ts: firebase.database.ServerValue.TIMESTAMP },
    };
    const p = `players/${PLAYER_ID}`;
    if (isInfection()) {
      updates[`${p}/role`] = 'hunter';
      updates[`${p}/infectedAt`] = Date.now(); // triggers the infection takeover screen
      updates[`${p}/taggedBy`] = 'Self-report';
      updates[`${p}/pingsRemaining`] = 1;
      updates[`${p}/tagCode`] = null;
      updates[`${p}/eliminated`] = false;
    } else {
      updates[`${p}/eliminated`] = true;
      updates[`${p}/eliminatedBy`] = 'honor system';
    }
    updates[`${p}/exposed`] = false;
    await roomRef.update(updates);
    if (isHost()) checkWinConditions();
  } catch (err) {
    console.error(err);
    toast(`Failed: ${err.message}`, 'error');
  } finally {
    S.selfTagging = false;
  }
}

/* ---------- Secret Admin Panel ---------- */
function openAdminPanel() {
  el.adminPanel.classList.remove('hidden');
  renderAdmin();
}
function closeAdminPanel() { el.adminPanel.classList.add('hidden'); }

function adminOmniPing() {
  S.omniUntil = Date.now() + 15000;
  renderMarkers();
  closeAdminPanel();
  toast('📡 Omni-Ping — all runners revealed for 15s', 'warn');
}

function adminTogglePause() {
  stateRef.update({ zonePaused: !S.room.zonePaused }).catch(console.error);
}

function adminAdjustZone(deltaFt) {
  stateRef.child('zone').transaction((cur) => {
    if (!cur || typeof cur.currentRadiusFeet !== 'number') return; // abort
    cur.currentRadiusFeet = Math.max(50, Math.round(cur.currentRadiusFeet + deltaFt));
    return cur;
  }).catch(console.error);
}

function adminAddTime() {
  if (typeof S.room.matchEndsAt === 'number') {
    stateRef.child('matchEndsAt').transaction((cur) => (typeof cur === 'number' ? cur + 300000 : cur)).catch(console.error);
  } else {
    // Clock hasn't started yet (grace period) — extend the planned duration.
    stateRef.update({ matchDurationMin: (S.room.matchDurationMin || 15) + 5 }).catch(console.error);
  }
  toast('⏳ +5 minutes added');
}

function adminEndMatch() {
  if (!confirm('End the match immediately?')) return;
  const aliveRunner = Object.values(S.players).some((p) => p.role === 'runner' && !p.eliminated);
  stateRef.update({
    status: STATUS.GAME_OVER,
    state: STATUS.GAME_OVER,
    winner: aliveRunner ? 'runners' : 'hunters',
  }).catch(console.error);
  closeAdminPanel();
}

function adminPlayerAction(id, action) {
  const p = `players/${id}`;
  const u = {};
  if (action === 'eliminate') {
    u[`${p}/eliminated`] = true;
    u[`${p}/eliminatedBy`] = 'Admin';
    u[`${p}/exposed`] = false;
  } else if (action === 'infect') {
    u[`${p}/role`] = 'hunter';
    u[`${p}/eliminated`] = false;
    u[`${p}/infectedAt`] = Date.now();
    u[`${p}/taggedBy`] = 'Admin';
    u[`${p}/pingsRemaining`] = 1;
    u[`${p}/tagCode`] = null;
    u[`${p}/exposed`] = false;
  } else if (action === 'respawn') {
    u[`${p}/eliminated`] = false;
    u[`${p}/eliminatedBy`] = null;
    u[`${p}/role`] = 'runner';
    u[`${p}/tagCode`] = generateTagCode();
    u[`${p}/infectedAt`] = null;
    u[`${p}/taggedBy`] = null;
    u[`${p}/pingsRemaining`] = null;
    u[`${p}/exposed`] = false;
  } else if (action === 'spectate') {
    u[`${p}/role`] = 'spectator';
    u[`${p}/eliminated`] = false;
    u[`${p}/eliminatedBy`] = null;
    u[`${p}/infectedAt`] = null;
    u[`${p}/tagCode`] = null;
    u[`${p}/taggedBy`] = null;
    u[`${p}/pingsRemaining`] = null;
    u[`${p}/exposed`] = false;
  }
  roomRef.update(u).catch((err) => toast(err.message, 'error'));
}

function adminToggleSpectator() {
  const isSpectating = me()?.role === 'spectator';
  adminPlayerAction(PLAYER_ID, isSpectating ? 'respawn' : 'spectate');
  toast(isSpectating ? '🏃 Exited Spectator Mode — joined as Runner' : '👁️ Spectator Mode: Full Map Vision enabled!', 'warn', 4000);
  closeAdminPanel();
}

function renderAdmin() {
  if (el.adminPanel.classList.contains('hidden')) return;
  el.adminPause.textContent = S.room.zonePaused ? '▶️ Resume Zone Shrink' : '⏸️ Pause Zone Shrink';
  if (el.adminSpectate) {
    const isSpec = me()?.role === 'spectator';
    el.adminSpectate.textContent = isSpec ? '🏃 Exit Spectator Mode' : '👁️ Enter Spectator Mode (Full Map Vision)';
    el.adminSpectate.classList.toggle('active', isSpec);
  }
  const frag = document.createDocumentFragment();
  const entries = Object.entries(S.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  for (const [id, p] of entries) {
    const wrap = document.createElement('div');
    wrap.className = 'admin-player';
    const name = document.createElement('div');
    name.className = 'admin-player-name';
    const status = p.eliminated ? 'eliminated' : (p.role || 'lobby');
    name.innerHTML = `<span>${escapeHtml(p.name)}</span><small>${escapeHtml(status)}</small>`;
    const actions = document.createElement('div');
    actions.className = 'admin-player-actions';
    [['eliminate', 'Eliminate'], ['infect', 'Infect'], ['respawn', 'Respawn'], ['spectate', 'Spectate']].forEach(([act, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `admin-btn${act === 'spectate' ? ' admin-btn-spectator' : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => adminPlayerAction(id, act));
      actions.appendChild(b);
    });
    wrap.append(name, actions);
    frag.appendChild(wrap);
  }
  el.adminPlayerList.replaceChildren(frag);
}

/* ---------- Player roster drawer ---------- */
function setRosterOpen(open) {
  el.rosterDrawer.classList.toggle('open', open);
  el.rosterDrawer.setAttribute('aria-hidden', String(!open));
  if (el.rosterToggleBtn) el.rosterToggleBtn.setAttribute('aria-expanded', String(open));
  el.rosterBackdrop.classList.toggle('hidden', !open);
}

function rosterRow(p, kind, extra) {
  const row = document.createElement('div');
  const now = serverNow();
  const lastActive = p.lastSeen || p.updatedAt || 0;
  const isSignalLow = !p.eliminated && lastActive > 0 && (now - lastActive > 60000);

  row.className = `roster-row${kind === 'out' ? ' out' : ''}${isSignalLow ? ' signal-low' : ''}`;
  const dot = document.createElement('span');
  dot.className = `roster-dot ${kind}`;
  const name = document.createElement('span');
  name.className = 'roster-name';
  name.textContent = p.name;
  row.append(dot, name);

  if (isSignalLow) {
    const lowTag = document.createElement('span');
    lowTag.className = 'roster-tag signal-low';
    lowTag.textContent = 'Signal Low';
    row.appendChild(lowTag);
  }

  if (extra) {
    const t = document.createElement('span');
    t.className = 'roster-tag';
    t.textContent = extra;
    row.appendChild(t);
  }
  return row;
}

function renderRoster() {
  if (!S.inGame) return;
  const all = Object.values(S.players);
  const out = all.filter((p) => p.eliminated);
  const hunters = all.filter((p) => p.role === 'hunter' && !p.eliminated);
  const runners = all.filter((p) => p.role === 'runner' && !p.eliminated);
  const spectators = all.filter((p) => p.role === 'spectator');

  if (el.aliveCount) el.aliveCount.textContent = `${runners.length} Alive`;
  el.rosterSummary.textContent = `Hunters (${hunters.length}) | Runners Left (${runners.length})${spectators.length ? ` | Spectators (${spectators.length})` : ''}`;

  const frag = document.createDocumentFragment();
  const group = (title, list, kind, extraFn) => {
    if (!list.length) return;
    const h = document.createElement('div');
    h.className = 'roster-group-title';
    h.textContent = title;
    frag.appendChild(h);
    list.forEach((p) => frag.appendChild(rosterRow(p, kind, extraFn ? extraFn(p) : '')));
  };
  group('Hunters', hunters, 'hunter', (p) => (p.infectedAt ? '☣️' : ''));
  group('Active Runners', runners, 'runner');
  group('Spectators', spectators, 'spectator', () => '👁️ God\'s Eye');
  group('Eliminated', out, 'out', () => 'Caught');
  el.rosterBody.replaceChildren(frag);
  renderAdmin();
}

/* ---------- Role splash ---------- */
function maybeShowReveal() {
  const role = myRole();
  if (!role || !S.room.startedAt || S.revealedFor === S.room.startedAt) return;
  S.revealedFor = S.room.startedAt;
  // Skip the splash if this is a reload into a game that's been running a while.
  if (serverNow() - S.room.startedAt > 30000) return;

  const inGrace = phase() === STATUS.GRACE;
  const graceLeft = formatMSS(Math.max(0, Math.ceil(((S.room.graceEndsAt || 0) - serverNow()) / 1000)));
  el.reveal.className = `reveal ${role}`;
  el.revealRole.textContent = role.toUpperCase();
  el.revealSub.textContent = role === 'hunter'
    ? (inGrace ? `You're frozen for ${graceLeft}. Then track down every runner.` : 'Track down every runner.')
    : (inGrace ? `Scatter! Hunters are frozen for ${graceLeft}.` : 'Stay hidden. Don\'t get caught.');
  vibrate(role === 'hunter' ? [120, 60, 120] : [200]);

  clearTimeout(el.reveal._t);
  el.reveal._t = setTimeout(hideReveal, 3500);
}

function hideReveal() {
  if (el.reveal.classList.contains('hidden')) return;
  el.reveal.classList.add('closing');
  setTimeout(() => { el.reveal.className = 'reveal hidden'; }, 350);
}

/* ---------- GPS ---------- */
function startGPS() {
  if (S.watchId !== null) return;
  if (!('geolocation' in navigator)) {
    S.gpsError = 'GPS is not supported on this device.';
    showGpsBanner(S.gpsError, true);
    updatePreview(false);
    return;
  }
  if (!window.isSecureContext) {
    S.gpsError = 'GPS requires HTTPS (or localhost).';
    showGpsBanner(S.gpsError, true);
  } else {
    showGpsBanner('Searching for GPS…');
  }
  S.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20000,
  });
}

function stopGPS() {
  if (S.watchId !== null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
  clearTimeout(S.pushTimer);
  S.pushTimer = null;
}

function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  const hadFix = !!S.myPos;
  S.myPos = { lat, lng, acc: accuracy || 0 };
  S.gpsError = '';
  el.gpsBanner.classList.add('hidden');

  const acc = Math.round(accuracy);
  el.gpsAccuracy.textContent = `±${acc} m`;
  el.gpsChip.className = `gps-chip ${acc <= 15 ? 'good' : acc <= 40 ? 'fair' : 'poor'}`;

  // Lobby: keep the host's zone preview centered on their live GPS.
  if (!S.inGame && !P.manualCenter) updatePreview(!hadFix);

  if (S.inGame) {
    checkZone();
    renderMarkers();
    if (S.follow) centerOnMe();
  }
  schedulePositionPush();
}

/** Throttled (leading + trailing) writes so we don't flood the database. */
function schedulePositionPush() {
  const elapsed = Date.now() - S.lastPush;
  if (elapsed >= POSITION_PUSH_INTERVAL_MS) {
    pushPosition();
  } else if (!S.pushTimer) {
    S.pushTimer = setTimeout(pushPosition, POSITION_PUSH_INTERVAL_MS - elapsed);
  }
}

function pushPosition() {
  clearTimeout(S.pushTimer);
  S.pushTimer = null;
  if (!S.myPos || !S.joined || !meRef) return;
  S.lastPush = Date.now();
  meRef.update({
    lat: S.myPos.lat,
    lng: S.myPos.lng,
    acc: Math.round(S.myPos.acc),
    lastSeen: firebase.database.ServerValue.TIMESTAMP,
    updatedAt: firebase.database.ServerValue.TIMESTAMP,
  }).catch((err) => console.warn('Position push failed', err));
}

function onPositionError(err) {
  const msgs = {
    1: 'Location permission denied — enable it in your browser settings.',
    2: 'Location unavailable — move to open sky.',
    3: 'Still searching for GPS…',
  };
  if (err.code !== 3) S.gpsError = msgs[err.code] || 'GPS error.';
  showGpsBanner(msgs[err.code] || 'GPS error', err.code !== 3);
  el.gpsChip.className = 'gps-chip poor';
  if (!S.inGame) updatePreview(false);
}

function showGpsBanner(text, isError = false) {
  el.gpsBannerText.textContent = text;
  el.gpsBanner.classList.toggle('error', isError);
  el.gpsBanner.classList.remove('hidden');
}

/* ---------- Screen Wake Lock ---------- */
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || S.wakeLock) return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
  } catch (err) {
    console.warn('Wake lock unavailable:', err.message);
  }
}

async function releaseWakeLock() {
  try { await S.wakeLock?.release(); } catch { /* ignore */ }
  S.wakeLock = null;
}

// Wake locks are auto-released when the tab is hidden — re-acquire on return.
// On visibilitychange to 'visible', resume GPS streaming and sync without reinitializing state.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (S.inGame) requestWakeLock();
    if (S.joined) {
      startGPS();
      if (S.myPos) pushPosition();
    }
  }
});

/* ---------------------------------------------------------
   13b. TEAM CHAT
   Channels: lobby (pre-game, everyone) · hunter · runner.
   Spectators read both teams and can post to either or to both.
   --------------------------------------------------------- */
const CHAT = { open: false, tab: null, data: {}, seenTs: {}, primed: {}, channels: [] };
const CHAT_LABEL = { lobby: '💬 Lobby Chat', hunter: '🔴 Hunter Chat', runner: '🔵 Runner Chat' };

function chatChannels() {
  if (!S.joined) return [];
  if (!isActive()) return ['lobby'];
  const r = myRole();
  if (r === 'spectator') return ['both', 'hunter', 'runner'];
  if (r === 'hunter' || r === 'runner') return [r];
  return [];
}

/** Sorted messages for a channel; 'both' merges hunter+runner (deduped by shared key). */
function chatMessages(ch) {
  const src = ch === 'both' ? ['hunter', 'runner'] : [ch];
  const map = new Map();
  for (const c of src) {
    for (const [k, m] of Object.entries(CHAT.data[c] || {})) {
      if (m && typeof m.text === 'string') map.set(k, { ...m, ch: c });
    }
  }
  return [...map.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-100);
}

function renderChat(chatData) {
  if (chatData !== undefined) CHAT.data = chatData || {};
  const channels = chatChannels();
  CHAT.channels = channels;
  el.chatFab.classList.toggle('hidden', channels.length === 0);
  if (!channels.length) {
    CHAT.open = false;
    el.chatPanel.classList.add('hidden');
    return;
  }
  if (!channels.includes(CHAT.tab)) CHAT.tab = channels[0];

  // Unread tracking across the real (non-merged) channels.
  let unread = 0;
  for (const c of ['lobby', 'hunter', 'runner']) {
    const msgs = Object.values(CHAT.data[c] || {}).filter((m) => m && typeof m.ts === 'number');
    const latest = msgs.reduce((mx, m) => Math.max(mx, m.ts), 0);
    if (!CHAT.primed[c]) { CHAT.primed[c] = true; CHAT.seenTs[c] = latest; continue; }
    const viewing = CHAT.open && (CHAT.tab === c || CHAT.tab === 'both' && c !== 'lobby');
    if (viewing) CHAT.seenTs[c] = latest;
    else if (channels.includes(c) || (channels.includes('both') && c !== 'lobby')) {
      unread += msgs.filter((m) => m.ts > (CHAT.seenTs[c] || 0) && m.uid !== PLAYER_ID).length;
    }
  }
  el.chatBadge.textContent = unread > 9 ? '9+' : String(unread);
  el.chatBadge.classList.toggle('hidden', unread === 0);

  el.chatTabs.classList.toggle('hidden', channels.length < 2);
  el.chatTabs.querySelectorAll('.chat-tab').forEach((b) => b.classList.toggle('active', b.dataset.ch === CHAT.tab));
  el.chatTitle.textContent = CHAT.tab === 'both'
    ? '📣 Spectator → Both Teams'
    : (CHAT_LABEL[CHAT.tab] || 'Chat');

  if (!CHAT.open) return;
  const nearBottom = el.chatLog.scrollHeight - el.chatLog.scrollTop - el.chatLog.clientHeight < 80;
  const frag = document.createDocumentFragment();
  const msgs = chatMessages(CHAT.tab);
  if (!msgs.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'No messages yet — say something!';
    frag.appendChild(empty);
  }
  for (const m of msgs) {
    const row = document.createElement('div');
    row.className = `chat-msg chat-${m.role || 'none'}${m.uid === PLAYER_ID ? ' chat-mine' : ''}`;
    const who = document.createElement('span');
    who.className = 'chat-who';
    const tag = m.role === 'spectator' ? '👁️ ' : '';
    const via = CHAT.tab === 'both' ? ` (${m.ch === 'hunter' ? 'H' : 'R'})` : '';
    who.textContent = `${tag}${m.name || '?'}${via}`;
    const txt = document.createElement('span');
    txt.className = 'chat-text';
    txt.textContent = m.text;
    row.append(who, txt);
    frag.appendChild(row);
  }
  el.chatLog.replaceChildren(frag);
  if (nearBottom || el.chatLog.dataset.fresh !== '0') {
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    el.chatLog.dataset.fresh = '0';
  }
}

function setChatOpen(open) {
  CHAT.open = open && CHAT.channels.length > 0;
  el.chatPanel.classList.toggle('hidden', !CHAT.open);
  el.chatFab.classList.toggle('hidden', CHAT.open || CHAT.channels.length === 0);
  el.chatLog.dataset.fresh = '1';
  renderChat();
  if (CHAT.open) setTimeout(() => el.chatInput.focus(), 50);
}

async function sendChat() {
  const text = el.chatInput.value.trim().slice(0, 200);
  if (!text || !S.joined || !CHAT.channels.includes(CHAT.tab) || !roomRef) return;
  const targets = CHAT.tab === 'both' ? ['hunter', 'runner'] : [CHAT.tab];
  const key = roomRef.child('chat').push().key;
  const msg = {
    uid: PLAYER_ID,
    name: S.name || me()?.name || 'Player',
    role: isActive() ? (myRole() || 'none') : 'none',
    text,
    ts: Math.round(serverNow()),
  };
  const updates = {};
  targets.forEach((c) => { updates[`chat/${c}/${key}`] = msg; });
  el.chatInput.value = '';
  try {
    await roomRef.update(updates);
  } catch (err) {
    console.error(err);
    toast(`Message failed: ${err.message}`, 'error');
  }
}

/* ---------------------------------------------------------
   14. EVENT WIRING
   --------------------------------------------------------- */
el.chatFab.addEventListener('click', () => setChatOpen(true));
el.chatClose.addEventListener('click', () => setChatOpen(false));
el.chatTabs.addEventListener('click', (e) => {
  const b = e.target.closest('.chat-tab');
  if (!b) return;
  CHAT.tab = b.dataset.ch;
  el.chatLog.dataset.fresh = '1';
  renderChat();
});
el.chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
el.roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinLobby(); });
el.joinBtn.addEventListener('click', joinLobby);
el.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinLobby(); });
el.nameInput.addEventListener('animationend', () => el.nameInput.classList.remove('shake'));
el.leaveBtn.addEventListener('click', leaveLobby);
el.startBtn.addEventListener('click', startGame);
el.endGameBtn.addEventListener('click', endGame);
el.recenterBtn.addEventListener('click', () => setFollow(true));
el.reveal.addEventListener('click', hideReveal);
el.pingBtn.addEventListener('click', firePing);
if (el.rosterToggleBtn) {
  el.rosterToggleBtn.addEventListener('click', () => setRosterOpen(!el.rosterDrawer.classList.contains('open')));
}
el.rosterClose.addEventListener('click', () => setRosterOpen(false));
el.rosterBackdrop.addEventListener('click', () => setRosterOpen(false));
el.selfTagBtn.addEventListener('click', () => el.selfTagConfirm.classList.remove('hidden'));
el.selfTagCancel.addEventListener('click', () => el.selfTagConfirm.classList.add('hidden'));
el.selfTagYes.addEventListener('click', confirmSelfTag);
el.adminClose.addEventListener('click', closeAdminPanel);
if (el.adminSpectate) el.adminSpectate.addEventListener('click', adminToggleSpectator);
el.adminOmni.addEventListener('click', adminOmniPing);
el.adminPause.addEventListener('click', adminTogglePause);
el.adminExpand.addEventListener('click', () => adminAdjustZone(250));
el.adminShrink.addEventListener('click', () => adminAdjustZone(-250));
el.adminAddTime.addEventListener('click', adminAddTime);
el.adminEnd.addEventListener('click', adminEndMatch);

// Direct Admin Access buttons
if (el.rosterAdminBtn) el.rosterAdminBtn.addEventListener('click', promptAdminPasscode);
if (el.lobbyAdminBtn) el.lobbyAdminBtn.addEventListener('click', promptAdminPasscode);

// Secret 3-tap triggers on HUD and Lobby title
let adminTapCount = 0;
let adminTapTimer = null;
function handleSecretAdminTap() {
  adminTapCount++;
  clearTimeout(adminTapTimer);
  adminTapTimer = setTimeout(() => { adminTapCount = 0; }, 1400);
  if (adminTapCount >= 3) {
    adminTapCount = 0;
    promptAdminPasscode();
  }
}
if (el.roleChip) el.roleChip.addEventListener('click', handleSecretAdminTap);
if (el.appTitle) el.appTitle.addEventListener('click', handleSecretAdminTap);

// Keyboard shortcut (Ctrl+Shift+A or ~) for desktop testing
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') || (e.key === '`' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName))) {
    e.preventDefault();
    promptAdminPasscode();
  }
});

// Quick Presets
if (el.presetBlitz) el.presetBlitz.addEventListener('click', () => applyPreset('blitz'));
if (el.presetTactical) el.presetTactical.addEventListener('click', () => applyPreset('tactical'));

// Host settings sliders, dropdowns & toggles
el.durationSlider.addEventListener('input', renderSettings);
el.radiusSlider.addEventListener('input', onStartRadiusInput);
el.radiusSlider.addEventListener('change', () => updatePreview(true));
if (el.shrinkToggle) {
  el.shrinkToggle.addEventListener('change', () => {
    renderSettings();
    updatePreview(false);
  });
}
if (el.shrinkPaceSelect) {
  el.shrinkPaceSelect.addEventListener('change', () => {
    el.shrinkSlider.value = el.shrinkPaceSelect.value;
    renderSettings();
    updatePreview(false);
  });
}
if (el.oobPenaltySelect) {
  el.oobPenaltySelect.addEventListener('change', renderSettings);
}
if (el.supplyDropToggle) {
  el.supplyDropToggle.addEventListener('change', renderSettings);
}
if (el.lmsToggle) {
  el.lmsToggle.addEventListener('change', renderSettings);
}
el.minRadiusSlider.addEventListener('input', onMinRadiusInput);
el.minRadiusSlider.addEventListener('change', () => updatePreview(true));
el.shrinkSlider.addEventListener('input', () => {
  renderSettings();
  updatePreview(false);
});
el.graceSlider.addEventListener('input', renderSettings);
el.zoneRecenterBtn.addEventListener('click', () => {
  P.manualCenter = null;
  updatePreview(true);
});

// Passcode Tag & Modal actions
el.tagSubmitBtn.addEventListener('click', submitHunterTag);
el.tagCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitHunterTag(); });
el.caughtDismissBtn.addEventListener('click', () => {
  S.dismissedCaught = true;
  el.caughtOverlay.classList.add('hidden');
});
el.gameOverLobbyBtn.addEventListener('click', () => {
  if (isHost()) returnToLobby();
  else el.gameOverModal.classList.add('hidden');
});

function stepHunters(delta) {
  const max = Number(el.hunterCount.max) || 99;
  const next = Math.min(max, Math.max(1, (parseInt(el.hunterCount.value, 10) || 1) + delta));
  el.hunterCount.value = next;
  vibrate(10);
}
el.hunterMinus.addEventListener('click', () => stepHunters(-1));
el.hunterPlus.addEventListener('click', () => stepHunters(1));

el.shareBtn.addEventListener('click', async () => {
  const url = new URL(location.href);
  url.searchParams.set('room', ROOM_ID);
  const link = url.toString();
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Manhunt Live', text: `Join my Manhunt room "${ROOM_ID}"`, url: link });
    } else {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied!');
    }
  } catch { /* user cancelled */ }
});

/* ---------------------------------------------------------
   15. BOOT
   --------------------------------------------------------- */
restoreSettings();
initFirebase();
