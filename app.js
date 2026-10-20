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
const COLORS = { hunter: '#ff2d4b', runner: '#1f8bff', none: '#6b7588' };
const POSITION_PUSH_INTERVAL_MS = 1000;
const LS = {
  playerId: 'manhunt.playerId',
  name: 'manhunt.name',
  settings: 'manhunt.settings',
  role: (room) => `manhunt.role.${room}`,
  pings: (room, startedAt) => `manhunt.pings.${room}.${startedAt}`,
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

const ROOM_ID = sanitizeRoom(new URLSearchParams(location.search).get('room')) || DEFAULT_ROOM;

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
  // Hunter radar
  pingKey: null,
  pingsUsed: 0,
  pingCooldownUntil: 0,
  pingRevealUntil: 0,
  pingWasActive: false,
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
  // Host settings
  durationSlider: $('duration-slider'),
  durationValue: $('duration-value'),
  graceSlider: $('grace-slider'),
  graceValue: $('grace-value'),
  radiusSlider: $('radius-slider'),
  radiusValue: $('radius-value'),
  shrinkToggle: $('shrink-toggle'),
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
  statusPill: $('status-pill'),
  roleChip: $('role-chip'),
  playerCount: $('player-count'),
  gameTimer: $('game-timer'),
  runnerScoreGroup: $('runner-score-group'),
  runnersAliveCount: $('runners-alive-count'),
  runnersTotalCount: $('runners-total-count'),
  runnerTagPill: $('runner-tag-pill'),
  runnerTagCode: $('runner-tag-code'),
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
  // Right-side Distance Visual HUD
  distanceHud: $('distance-hud'),
  distIndicatorDot: $('dist-indicator-dot'),
  distToggleBtn: $('dist-toggle-btn'),
  distEdgeNum: $('dist-edge-num'),
  distEdgeLabel: $('dist-edge-label'),
  distBorderLine: $('dist-border-line'),
  distMinLine: $('dist-min-line'),
  distPlayerPin: $('dist-player-pin'),
  distPinText: $('dist-pin-text'),
  distTargetsContainer: $('dist-targets-container'),
  distDetails: $('dist-details'),
  distFromCenter: $('dist-from-center'),
  distZoneRadius: $('dist-zone-radius'),
  distTargetRow: $('dist-target-row'),
  distTargetLabel: $('dist-target-label'),
  distTargetVal: $('dist-target-val'),
  distStatusBadge: $('dist-status-badge'),
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

const isHost = () => S.room.hostId === PLAYER_ID;
const me = () => S.players[PLAYER_ID];
const myRole = () => me()?.role || null;
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
function isVisibleToMe(id, p) {
  if (id === PLAYER_ID) return true;
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

    const role = p.role === 'hunter' || p.role === 'runner' ? p.role : 'none';
    const exposed = phase() === STATUS.PLAYING && (isMe ? S.exposed : p.exposed === true);
    const outOfBounds = p.role === 'runner' && exposed;

    const style = {
      radius: isMe ? 12 : 10,
      color: outOfBounds ? '#ffffff' : (exposed ? ZONE_COLOR : '#ffffff'),
      weight: isMe ? 4 : 3,
      fillColor: outOfBounds ? '#ef4444' : COLORS[role],
      fillOpacity: 1,
    };

    let label;
    if (outOfBounds) {
      label = `<span class="tip tip-runner tip-out-of-bounds">${escapeHtml(p.name)} (OUT OF BOUNDS)</span>`;
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
  if (!S.connected) {
    if (S.joined) toast('Connection lost — reconnecting…', 'warn');
    return;
  }
  if (!S.joined) return;
  registerPresence();
}

async function registerPresence() {
  // onDisconnect is executed by the server when this client drops — cleans up ghosts.
  await meRef.onDisconnect().remove();
  if (isHost()) await stateRef.child('hostId').onDisconnect().remove();

  const role = isActive() ? (myRole() || restoreRole() || 'runner') : null;
  const existing = me();
  await meRef.set({
    name: S.name,
    joinedAt: existing?.joinedAt || firebase.database.ServerValue.TIMESTAMP,
    role,
    exposed: S.exposed,
    lat: S.myPos?.lat ?? null,
    lng: S.myPos?.lng ?? null,
    acc: S.myPos ? Math.round(S.myPos.acc) : null,
    updatedAt: firebase.database.ServerValue.TIMESTAMP,
  });
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
      await stateRef.child('hostId').onDisconnect().remove();
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
    shrinkFtPerMin: Number(el.shrinkSlider.value),
    shrinkEnabled: el.shrinkToggle ? el.shrinkToggle.checked : true,
  };
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

  if (!s.shrinkEnabled) {
    el.minRadiusSlider.disabled = true;
    el.shrinkSlider.disabled = true;
    el.minRadiusGroup.classList.add('disabled');
    el.shrinkSpeedGroup.classList.add('disabled');
    el.minRadiusValue.textContent = 'Min Radius: Disabled (No Shrink)';
    el.shrinkValue.textContent = 'Shrink Speed: Disabled (Static Zone)';
    el.zoneSummary.textContent =
      `Hunt starts after ${formatMSS(s.graceSec)} · zone remains static at ${fmtFt(s.startRadiusFt)} ft for full ${s.durationMin} min`;
  } else {
    el.minRadiusSlider.disabled = false;
    el.shrinkSlider.disabled = false;
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
      if (s.shrinkFtPerMin) el.shrinkSlider.value = s.shrinkFtPerMin;
      if (typeof s.shrinkEnabled === 'boolean' && el.shrinkToggle) {
        el.shrinkToggle.checked = s.shrinkEnabled;
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
    updates[`players/${id}/tagCode`] = isHunter ? null : String(randomInt(9000) + 1000);
    updates[`players/${id}/eliminated`] = false;
    updates[`players/${id}/eliminatedBy`] = null;
    updates[`players/${id}/exposed`] = false;
  });
  updates['state/status'] = STATUS.GRACE;
  updates['state/state'] = STATUS.GRACE;
  updates['state/hunterCount'] = hunters;
  updates['state/startedAt'] = firebase.database.ServerValue.TIMESTAMP;
  updates['state/gracePeriodSec'] = cfg.graceSec;
  updates['state/graceEndsAt'] = Math.round(serverNow() + cfg.graceSec * 1000);
  updates['state/matchDurationMin'] = cfg.durationMin;
  updates['state/totalPings'] = maxPingsForDuration(cfg.durationMin);
  updates['state/matchEndsAt'] = null;
  updates['state/winner'] = null;
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
  };
  Object.keys(S.players).forEach((id) => {
    updates[`players/${id}/role`] = null;
    updates[`players/${id}/tagCode`] = null;
    updates[`players/${id}/eliminated`] = null;
    updates[`players/${id}/eliminatedBy`] = null;
    updates[`players/${id}/exposed`] = null;
  });
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
  S.dismissedCaught = false;
  document.body.classList.remove('out-of-zone');

  el.statusPill.classList.add('hidden');
  el.gameControls.classList.add('hidden');
  el.recenterBtn.classList.add('hidden');
  el.gpsBanner.classList.add('hidden');
  el.graceBanner.classList.add('hidden');
  el.zoneBanner.classList.add('hidden');
  el.hunterLock.classList.add('hidden');
  el.radarSweep.classList.add('hidden');
  el.pingBtn.classList.add('hidden');
  el.distanceHud.classList.add('hidden');
  el.runnerTagPill.classList.add('hidden');
  el.hunterTagBar.classList.add('hidden');
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

  // Radar reveal just expired → hide runners again.
  const active = pingActive();
  if (active !== S.pingWasActive) {
    S.pingWasActive = active;
    renderMarkers();
  }
  renderPingButton();
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
  syncHostLoops();
}

function checkWinConditions() {
  if (!isHost() || phase() !== STATUS.PLAYING) return;
  const runners = Object.values(S.players).filter((p) => p.role === 'runner');
  if (runners.length === 0) return;

  const aliveRunners = runners.filter((p) => !p.eliminated);
  if (aliveRunners.length === 0) {
    endMatch('hunters');
    return;
  }

  if (S.room.matchEndsAt && serverNow() >= S.room.matchEndsAt) {
    if (aliveRunners.length > 0) {
      endMatch('runners');
    } else {
      endMatch('hunters');
    }
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
  el.roleChip.className = `role-chip ${role || ''}`;
  el.roleChip.textContent = role ? role.toUpperCase() : '…';
  el.playerCount.textContent = Object.keys(S.players).length;
  el.endGameBtn.classList.toggle('hidden', !isHost());

  // Runner score ticker
  const runners = Object.values(S.players).filter((p) => p.role === 'runner');
  if (isActive() && runners.length > 0) {
    el.runnerScoreGroup.classList.remove('hidden');
    const alive = runners.filter((p) => !p.eliminated).length;
    el.runnersAliveCount.textContent = alive;
    el.runnersTotalCount.textContent = runners.length;
  } else {
    el.runnerScoreGroup.classList.add('hidden');
  }

  // Runner secret tag code display
  const isRunner = role === 'runner';
  const myPlayer = me();
  if (isRunner && isActive() && myPlayer?.tagCode) {
    el.runnerTagPill.classList.remove('hidden');
    el.runnerTagCode.textContent = `[ ${myPlayer.tagCode} ]`;
  } else {
    el.runnerTagPill.classList.add('hidden');
  }

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

  el.statSurvivors.textContent = alive;
  el.statEliminated.textContent = eliminated;

  if (winner === 'hunters') {
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
  if (ph === STATUS.PLAYING && S.room.matchEndsAt) {
    const leftMs = Math.max(0, S.room.matchEndsAt - serverNow());
    el.gameTimer.textContent = formatCountdown(leftMs);
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
  const revealed = outside && ph === STATUS.PLAYING;

  el.zoneBanner.classList.toggle('hidden', !outside);
  el.zoneBanner.classList.toggle('soft', outside && !revealed);
  if (outside) {
    el.zoneBannerText.textContent = revealed
      ? '⚠️ OUTSIDE SAFE ZONE - YOU ARE REVEALED!'
      : '⚠️ Outside the safe zone — get inside before the hunt begins!';
  }
  document.body.classList.toggle('out-of-zone', revealed);

  if (revealed !== S.exposed) {
    S.exposed = revealed;
    if (revealed) vibrate([300, 100, 300]);
    else if (S.inGame) toast('✅ Back inside the safe zone — hidden again');
    if (meRef && S.joined) meRef.update({ exposed: revealed }).catch((err) => console.warn('Exposure write failed', err));
  }

  // Update right-side tactical distance visual
  renderDistanceHUD();
}

/* ---------- Tactical Right-Side Distance Visual HUD ---------- */
function renderDistanceHUD() {
  const z = zone();
  const show = S.inGame && !!z;
  el.distanceHud.classList.toggle('hidden', !show);
  if (!show) return;

  const ph = phase();
  const role = myRole();

  if (S.distFeet !== null) {
    const edgeDelta = z.currentRadiusFeet - S.distFeet;
    const isOut = edgeDelta < 0;
    const isClose = !isOut && edgeDelta < (z.currentRadiusFeet * 0.18);

    if (isOut) {
      el.distEdgeNum.textContent = `+${fmtFt(-edgeDelta)}`;
      el.distEdgeNum.className = 'dist-number danger mono';
      el.distEdgeLabel.textContent = ph === STATUS.PLAYING ? 'EXPOSED OUTSIDE!' : 'OUTSIDE ZONE!';
      el.distStatusBadge.textContent = ph === STATUS.PLAYING ? 'EXPOSED ⚠️' : 'OUTSIDE';
      el.distStatusBadge.className = 'dist-status-badge out-zone';
      el.distIndicatorDot.className = 'dist-indicator-dot danger';
      el.distPlayerPin.classList.add('danger');
    } else {
      el.distEdgeNum.textContent = fmtFt(edgeDelta);
      el.distEdgeNum.className = isClose ? 'dist-number warn mono' : 'dist-number safe mono';
      el.distEdgeLabel.textContent = 'TO SAFE BORDER';
      el.distStatusBadge.textContent = isClose ? 'NEAR BORDER' : 'SAFE IN ZONE';
      el.distStatusBadge.className = isClose ? 'dist-status-badge out-zone' : 'dist-status-badge in-zone';
      el.distIndicatorDot.className = 'dist-indicator-dot';
      el.distPlayerPin.classList.remove('danger');
    }

    // Ruler track calculation:
    // Bottom (0%) is zone center (0 ft).
    // Perimeter line is at 80% mark.
    // > 80% represents danger / outside territory (up to 96%).
    let bottomPct = 0;
    if (S.distFeet <= z.currentRadiusFeet) {
      bottomPct = (S.distFeet / Math.max(1, z.currentRadiusFeet)) * 80;
    } else {
      const extra = S.distFeet - z.currentRadiusFeet;
      const extraRatio = Math.min(1, extra / Math.max(50, z.currentRadiusFeet * 0.35));
      bottomPct = 80 + (extraRatio * 16);
    }
    el.distPlayerPin.style.bottom = `${Math.max(2, Math.min(96, bottomPct))}%`;
    el.distPlayerPin.classList.toggle('hunter', role === 'hunter');
    el.distFromCenter.textContent = `${fmtFt(S.distFeet)} ft`;
  } else {
    el.distEdgeNum.textContent = '---';
    el.distEdgeNum.className = 'dist-number mono';
    el.distEdgeLabel.textContent = 'LOCATING GPS…';
    el.distFromCenter.textContent = '-- ft';
    el.distPlayerPin.style.bottom = '50%';
  }

  el.distZoneRadius.textContent = `${fmtFt(z.currentRadiusFeet)} ft`;

  // Dynamic Min Radius marker line position on gauge
  if (z.minRadiusFeet && z.currentRadiusFeet > 0) {
    const minPct = (z.minRadiusFeet / z.currentRadiusFeet) * 80;
    el.distMinLine.style.bottom = `${Math.max(4, Math.min(75, minPct))}%`;
    el.distMinLine.classList.remove('hidden');
  } else {
    el.distMinLine.classList.add('hidden');
  }

  // Hunter Radar & Targets on Ruler
  renderDistanceTargets(z);
}

function renderDistanceTargets(z) {
  const role = myRole();
  el.distTargetsContainer.replaceChildren();

  if (role !== 'hunter' || !S.myPos || !z) {
    el.distTargetRow.classList.add('hidden');
    return;
  }

  let closestDist = Infinity;
  let targetCount = 0;

  for (const [id, p] of Object.entries(S.players)) {
    if (id === PLAYER_ID || p.role !== 'runner') continue;
    if (!isVisibleToMe(id, p)) continue;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;

    const runnerDist = map.distance([S.myPos.lat, S.myPos.lng], [p.lat, p.lng]) / FT_TO_M;
    if (runnerDist < closestDist) closestDist = runnerDist;

    // Runner's distance from zone center for the vertical rail
    const runnerFromCenter = map.distance([p.lat, p.lng], [z.centerLat, z.centerLng]) / FT_TO_M;
    let rPct = 0;
    if (runnerFromCenter <= z.currentRadiusFeet) {
      rPct = (runnerFromCenter / Math.max(1, z.currentRadiusFeet)) * 80;
    } else {
      const extra = runnerFromCenter - z.currentRadiusFeet;
      rPct = 80 + (Math.min(1, extra / Math.max(50, z.currentRadiusFeet * 0.35)) * 16);
    }

    const dot = document.createElement('div');
    dot.className = 'dist-target-pin';
    dot.style.bottom = `${Math.max(2, Math.min(96, rPct))}%`;
    dot.title = `${escapeHtml(p.name)} (${Math.round(runnerDist)} ft away)`;
    el.distTargetsContainer.appendChild(dot);
    targetCount++;
  }

  if (closestDist < Infinity && targetCount > 0) {
    el.distTargetRow.classList.remove('hidden');
    el.distTargetLabel.textContent = 'Nearest';
    el.distTargetVal.textContent = `${fmtFt(closestDist)} ft`;
  } else {
    el.distTargetRow.classList.add('hidden');
  }
}

/* ---------- Hunter radar ping ---------- */
function getMaxPings() {
  return S.room.totalPings || maxPingsForDuration(S.room.matchDurationMin || 15);
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
  const now = Date.now();
  const maxP = getMaxPings();
  if (S.pingsUsed >= maxP || now < S.pingCooldownUntil) return;

  S.pingsUsed += 1;
  S.pingCooldownUntil = now + PING_COOLDOWN_MS;
  savePings();

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
  const left = Math.max(0, maxP - S.pingsUsed);
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
  const maxP = getMaxPings();
  const left = Math.max(0, maxP - S.pingsUsed);
  let text, mode, progress = 0;

  if (phase() !== STATUS.PLAYING) {
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
  if (myRole() !== 'hunter' || phase() !== STATUS.PLAYING || S.tagSubmitting) return;
  const rawCode = el.tagCodeInput.value.trim();
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
    toast(`❌ Invalid code [${rawCode}] — No runner matched!`, 'error');
    vibrate([100, 50, 100]);
    el.tagCodeInput.value = '';
    return;
  }

  const [targetId, runner] = match;
  S.tagSubmitting = true;
  el.tagSubmitBtn.disabled = true;

  try {
    await playersRef.child(targetId).update({
      eliminated: true,
      eliminatedBy: S.name || 'Hunter',
      exposed: false,
    });
    vibrate([200, 100, 200, 100, 400]);
    toast(`💥 TAGGED! ${runner.name} is eliminated!`, '', 4000);
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.inGame) {
    requestWakeLock();
    if (S.myPos) pushPosition();
  }
});

/* ---------------------------------------------------------
   14. EVENT WIRING
   --------------------------------------------------------- */
el.joinBtn.addEventListener('click', joinLobby);
el.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinLobby(); });
el.nameInput.addEventListener('animationend', () => el.nameInput.classList.remove('shake'));
el.leaveBtn.addEventListener('click', leaveLobby);
el.startBtn.addEventListener('click', startGame);
el.endGameBtn.addEventListener('click', endGame);
el.recenterBtn.addEventListener('click', () => setFollow(true));
el.reveal.addEventListener('click', hideReveal);
el.pingBtn.addEventListener('click', firePing);
el.distToggleBtn.addEventListener('click', () => el.distanceHud.classList.toggle('expanded'));

// Host settings sliders & toggle
el.durationSlider.addEventListener('input', renderSettings);
el.radiusSlider.addEventListener('input', onStartRadiusInput);
el.radiusSlider.addEventListener('change', () => updatePreview(true));
if (el.shrinkToggle) {
  el.shrinkToggle.addEventListener('change', () => {
    renderSettings();
    updatePreview(false);
  });
}
el.minRadiusSlider.addEventListener('input', onMinRadiusInput);
el.minRadiusSlider.addEventListener('change', () => updatePreview(true));
el.shrinkSlider.addEventListener('input', renderSettings);
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
