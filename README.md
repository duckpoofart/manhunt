# Manhunt

> Real-world outdoor manhunt meets battle royale. Grab your phones, head to a park or campus, and survive the shrinking safe zone.

**Play Live:** https://duckpoofart.github.io/manhunt/

---

## 🎮 How It Works

- **Runners (Blue):** Scatter during grace period, stay inside the shrinking perimeter, hide your secret 4-digit code, and survive until the clock hits `00:00`.
- **Hunters (Red):** Frozen during grace period. Track runners using limited sonar radar pings or border-breach alerts, get close enough to read their code, and punch it in to eliminate them.

---

## ✨ Features

- **🛰️ Satellite Tactical Map:** High-res Esri aerial tiles, street overlay, real-time imperial scale (feet), and GPS accuracy halo.
- **⏱️ Shrinking Safe Zone:** Custom radius, adjustable shrink speeds (down to a crawl), or toggle "No Shrink" for classic hide-and-seek.
- **👀 Stealth & Out-of-Bounds:** Runners are 100% invisible on radar—until they step outside the border, blinking their live location to every hunter.
- **📡 Ghost Radar Pings:** Hunters get limited snapshots based on match length (1 ping per 5 min, 60s cooldown). Freezes runner locations for 15s without live tracking.
- **🔢 4-Digit Sight Tagging:** Zero GPS drift disputes or aggressive tackling. Runners keep their screens hidden; hunters eliminate runners by entering the code visible on their HUD.
- **📏 Tactical Distance HUD:** Vertical tape gauge showing exact feet to the border danger zone, plus a collapsible drawer tracking the nearest runner.
- **⚡ Zero Setup Required:** Instant room links (`?room=park-run`), auto-host failover, screen wake-lock (no screen sleep mid-chase), and native haptic vibration.

---

## 🛠️ Tech Stack

- **Frontend:** Vanilla JS / HTML5 / CSS3
- **Mapping:** [Leaflet.js](https://leafletjs.com/) + Esri World Satellite Tiles
- **Backend / Sync:** Firebase Realtime Database (clock-offset sync, sub-second coordinate throttling, `.onDisconnect()` cleanup)
- **APIs:** Geolocation API, Screen Wake Lock API, Vibration API, Web Share API

---

## 🚀 Quick Start

1. Clone the repo:
   ```bash
   git clone [https://github.com/your-username/gps-manhunt.git](https://github.com/your-username/gps-manhunt.git)
   cd gps-manhunt
