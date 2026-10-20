manhunt with cool features

### 1. Core Game Concept & Roles
* **Real-World GPS Hide & Seek**: Players use their real-world phones/devices outdoors to play a battle-royale/manhunt hybrid game in parks, campuses, or neighborhoods.
* **Roles**:
  * **Runners (Blue)**: Scatter, stay within the shrinking safe zone boundary, hide their 4-digit secret tag code, and survive until the match clock hits `00:00`.
  * **Hunters (Red)**: Wait out the grace period while frozen, track runners using visual range radar pings and border-breach alerts, and capture runners by entering their 4-digit code.
* **Role Assignment**: Fisher–Yates cryptographic shuffle automatically balances requested hunter/runner counts.

---

### 2. Map & Tactical Visuals
* **Esri World Satellite Imagery**: High-resolution aerial satellite tiles with crisp clarity down to zoom level 19.
* **Street Labels & Boundary Overlay**: Transparent road lines, landmarks, and street names overlaid on the satellite photography.
* **Imperial Distance Standard**: All game mechanics, circle markers, and displays work strictly in imperial **feet** (with 1 ft = 0.3048 m conversion under the hood for Leaflet).
* **Imperial Map Scale Bar**: Live distance scale indicator in the bottom-right corner.
* **Follow Mode & Smooth Pan**: Auto-centers on your current position; automatically pauses follow mode if you drag/pan the map, with a quick-tap floating action button to re-center.
* **Accuracy Halo**: Translucent circle reflecting the real-time GPS accuracy radius in meters/feet.

---

### 3. Lobby & Host Setup Controls
* **Instant Room Creation / Joining**: Shareable link system (`?room=park-hunt-1`) with clipboard copy and native mobile Web Share API integration.
* **First-In Host Election**: Earliest player automatically becomes host; seamlessly re-elects the next player if the host disconnects.
* **Match Duration Slider**: 5 to 60 minutes (step 5 min), dynamically calculating allowed hunter pings (1 ping per 5 minutes).
* **Grace Period Slider**: 30 to 300 seconds (step 15s) with live `M:SS` readout.
* **Starting Safe Zone Radius Slider**: 200 to 5,000 ft (step 50 ft).
* **"Enable Zone Shrinking" Toggle ("No Shrink" Mode)**:
  * When checked: Safe zone steadily contracts during the hunt down to the minimum radius.
  * When unchecked: Safe zone remains completely static for the entire match, disabling the minimum radius and shrink speed controls.
* **Minimum Final Radius Slider**: 50 to 500 ft (step 25 ft).
* **Shrink Speed Slider**: 1 to 300 ft/min (step 1 ft/min), allowing ultra-slow, suspenseful contractions down to 1 ft per minute.
* **Interactive Leaflet Mini-Preview Map**:
  * Center defaults to the host’s live GPS coordinates.
  * Host can tap anywhere on the map to place a custom zone center.
  * Real-time preview circles: Red dashed circle for starting radius, Amber circle for final minimum radius.
  * "Use my GPS" button to re-center on the host.
* **Hunter Count Stepper**: Increment/decrement number of hunters with safety bounds (`1` to `players - 1`).

---

### 4. Game Lifecycle & Win Conditions
1. **Lobby Phase**: Players join with custom nicknames, choose hunter counts, configure zone rules, and preview the safe zone.
2. **Grace Period (Countdown)**:
   * **Runners**: Get a scatter alert with a top progress bar: *"Runners — scatter and hide now!"*.
   * **Hunters**: Fully blinded and frozen behind a locked fullscreen overlay (*"HUNTERS BLINDED & FROZEN"*), unable to see runner locations or use radar.
3. **Active Hunt Phase**:
   * Synchronous match timer counts down from the configured match duration to `00:00`.
   * Haptic vibration bursts alert players that the hunt has begun.
   * Zone begins shrinking according to the configured speed (if enabled).
4. **Game Over Modal (`#game-over-modal`)**:
   * **Hunters Win**: If all runners are successfully tagged before time expires.
   * **Runners Win**: If the clock reaches `00:00` with at least one surviving runner.
   * Displays surviving vs. eliminated runner counts.
   * Host has a one-click button to reset the room back to the lobby.

---

### 5. Stealth & Visibility System
* **100% Invisible Runners**: Hunters cannot see runners on their map during normal gameplay.
* **Safe Zone Out-of-Bounds Detection**:
  * If a runner strays outside the red dashed perimeter:
    * **Runner's screen**: Turns red with a persistent warning banner (*"⚠️ OUTSIDE SAFE ZONE - YOU ARE REVEALED!"*) and warning vibration pulses.
    * **Hunters' screens**: The runner’s live GPS position immediately reveals in **blinking red** with the tooltip `"[Runner Name] (OUT OF BOUNDS)"` until they re-enter the boundary.
* **Runner Team Visibility**: Runners can always see their fellow teammates and hunters.

---

### 6. Hunter Radar Ping & Ghost Snapshot System
* **Ping Allowance Formula**: `Math.max(1, Math.floor(matchDurationMin / 5))`
  * *15-minute game = 3 pings total*
  * *20-minute game = 4 pings total*
  * *60-minute game = 12 pings total*
* **1-Minute Cooldown**: Exactly 60 seconds between pings. The HUD button displays a live countdown: `"Cooldown: 48s..."` with an animated circular progress border.
* **Persistent Counter**: Pings used and cooldown timestamps are stored locally per match ID, preventing refresh/reload exploits.
* **Ghost Snapshot Markers**:
  * Clicking "Ping Radar" freezes the instantaneous coordinates of all surviving runners at that exact second.
  * Places static, non-moving **Ghost Pins** on the hunter’s map with glowing sonar pulse animations.
  * Displays a permanent timestamp label: `"[Runner Name] (Snapshot: 14:22:05)"`.
  * Markers **do not** track or follow runners as they run away.
  * Automatically fades out and vanishes after **15 seconds**.

---

### 7. Secret Passcode Tagging System
* **Physical Proximity / Visual Tagging**: Instead of GPS-only proximity errors or physical tackling:
  * Each runner gets a randomly generated 4-digit code (e.g. `[ 7392 ]`) displayed on their top HUD pill: `"YOUR TAG CODE: [ 7392 ]"`.
  * Runners must keep their phone screens shielded from hunters' view.
* **Hunter Submission Bar**: Hunters have a numeric input field and `"SUBMIT TAG"` button on their HUD.
* **Instant Elimination**: Entering a runner's matching 4-digit code:
  * Eliminates the runner in Firebase.
  * Triggers a heavy haptic buzz.
  * Removes their active presence from runner count.
  * Updates the live header score ticker: `"🏃 2/4"`.
* **Caught Fullscreen Overlay (`#caught-overlay`)**:
  * The eliminated runner's screen pops up with: `"YOU HAVE BEEN CAUGHT! Tagged by [Hunter Name]"`.
  * Provides a button to dismiss and spectate the remainder of the match.

---

### 8. Tactical Right-Side Distance Gauge
* **Live Distance to Border**: Constantly computes feet to the safe perimeter.
* **Tactical Vertical Tape / Ruler**:
  * Vertical bar where bottom is the zone center and the top is outside danger territory.
  * Real-time sliding pin showing your exact relative depth inside or outside the circle.
  * Amber line denoting the minimum final contraction limit.
* **Hunter Target Rail**: Shows pins for detected targets and calculates the exact distance to the nearest runner.
* **Collapsible Drawer**: Tap to expand or collapse detailed metrics (Distance from center, Current radius, Nearest target distance, Safe/Exposed status badge).

---

### 9. Infrastructure, Presence & Networking
* **Firebase Realtime Database (Compat)**:
  * Sub-second live coordinate sync throttled intelligently (`POSITION_PUSH_INTERVAL_MS = 1000`) to avoid flooding connections.
  * Server time offset compensation (`.info/serverTimeOffset`) ensures timers are synchronized down to the millisecond across all devices regardless of clock drift.
  * Atomic multi-path updates for clean game state transitions.
  * Disconnect hooks (`.onDisconnect()`) clean up disconnected players and orphaned host claims automatically.
* **Persistent Player Identity**: Anonymous UUIDs saved in `localStorage` ensure reloads don't duplicate players or lose roles.
* **Screen Wake Lock API**: Automatically prevents phones from dimming or locking screens during an active game session; re-acquires lock when returning to the tab.
* **Haptic Vibration Feedback**: Custom vibration patterns for role reveal, tag submission, radar pings, out-of-bounds warnings, and grace period end.
