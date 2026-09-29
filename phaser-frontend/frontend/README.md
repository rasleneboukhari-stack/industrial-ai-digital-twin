# Industrial AI Digital Twin Factory — Phaser Frontend

A standalone TypeScript + Phaser frontend for the interactive industrial digital-twin factory simulator. This package is the visualization/operator layer only: it renders `FactoryState` / `MachineState`, presents AI and maintenance information, and sends commands through the `FactoryBackend` abstraction. Machine physics, PLC logic, ML inference and telemetry storage do not live in Phaser.

The included `MockFactoryBackend` provides a complete visual demonstration while the real industrial backend is not connected. All fabricated machine/maintenance behavior is isolated there so the same scenes and UI can later run against `WebSocketFactoryBackend`.

## Requirements

- Node.js 18+ (Node.js 22 LTS recommended)
- npm

The project uses Vite 6 so it also works with Node 18.19.x; you do not need Node 20 merely to preview this frontend.

## Exact run instructions

From inside this `frontend/` directory:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, normally:

```text
http://localhost:5173/
```

Production build:

```bash
npm run build
```

Preview the built application:

```bash
npm run preview
```

## Controls

- `WASD` / arrow keys — move operator
- `E` — inspect a nearby machine or use the control-room console
- `P` — open / close industrial handheld
- `M` — open / close expanded factory map
- `ESC` — close the active foreground interface
- `↑` / `↓` or mouse wheel — page through long phone screens
- HUD sound control — mute/unmute and adjust master volume
- AI assistant avatar — click to reopen the latest AI message; `OPEN AI` opens its phone history
- Simulation controls — `PAUSE`, `1x`, `10x`, `60x`, `600x`, `10Kx` (`10000x`)

Browsers block autoplay audio. Factory audio starts only after the first keyboard or mouse interaction. This is intentional.

## What is included

- Large top-down factory with Zones A/B/C and 18 data-driven machines
- Original placeholder pixel-art assets under `assets/`
- Original locally generated placeholder audio under `assets/audio/`
- Playable operator, collision and camera follow
- Machine visuals driven only by received machine state
- RPM/load/cooling/vibration/temperature/status presentation
- Clear RUNNING / STOPPED / FAULT / OFFLINE distinction
- Machine selection highlighting
- Compact real-time minimap using the real machine layout and world dimensions
- Expanded `M` factory map with zones, rooms, machines, operator and technicians
- Industrial phone with Alerts, Machines, Machine, AI, Maintenance and Events tabs
- Compact pixel-art AI assistant that queues important backend AI messages without covering gameplay
- Alert lifecycle: ACTIVE / ACKNOWLEDGED / MITIGATED / RESOLVED
- Existing SYSTEM alert presentation remains the deterministic operational-alert channel
- AI predictions/recommendations/decisions use the separate `AIMessage` presentation channel and AI phone history
- Alert acknowledgement without pretending the fault is repaired
- State-aware START / STOP / REDUCE LOAD / COOLING / maintenance controls
- Pending command feedback (`SENDING`, acknowledged/rejected) and duplicate-command protection
- High-risk START confirmation UX
- Factory time HUD with backend-provided simulation day
- 10000x simulation speed support
- Factory output / demand / ambient-temperature HUD
- Control-room overview with machine counts, risk counts and recent events
- Two visual maintenance technicians and queued maintenance workflow
- Simulated-time maintenance phases and post-maintenance manual restart
- Efficient audio: global ambience plus nearest-machine motor/fan presentation instead of one loop per machine
- Responsive HUD placement for common desktop resolutions
- `MockFactoryBackend` and `WebSocketFactoryBackend` behind the same contract

## Quick maintenance demo

The mock scenario intentionally starts M07 with a HIGH-risk bearing-degradation example.

1. Inspect M07 or select it from the phone/map.
2. Send `STOP`.
3. M07 stops, but its bearing issue and HIGH risk remain. The recommendation changes to `REQUEST_MAINTENANCE`.
4. Request maintenance.
5. Technician T01/T02 is assigned (or the request queues if both are busy), walks to M07, diagnoses, repairs and tests it.
6. Use `10Kx` to advance the simulated repair quickly; use `PAUSE` whenever you want to inspect a stage.
7. After `COMPLETED`, the mock warning resolves, but M07 remains stopped.
8. Press `START` to return M07 to production.

Maintenance duration follows **simulated time**, not wall-clock time. The technician NPC is only a visualization of backend maintenance state; it does not repair machine physics itself.

## Backend boundary

```text
Phaser UI/action
    -> FactoryBackend.sendCommand(...)
    -> backend / gateway / PLC / physical simulator
    -> new FactoryState / MachineState
    -> Phaser renders the returned state
```

The Phaser scenes do not contain physical machine rules such as temperature equations, bearing wear, random failure logic, PLC control, predictive ML or telemetry persistence. Mock-only physical responses and mock maintenance progression are contained in `src/backend/MockFactoryBackend.ts`.

## Real backend integration

Copy the example environment file:

```bash
cp .env.example .env
```

Set:

```dotenv
VITE_USE_REAL_BACKEND=true
VITE_FACTORY_WS_URL=ws://localhost:8080/ws/factory
VITE_FACTORY_HTTP_URL=http://localhost:8080/api
```

`WebSocketFactoryBackend` currently expects these conceptual routes:

```text
GET  /api/factory/state
GET  /api/machines/:id
POST /api/machines/:id/commands
POST /api/simulation/speed
POST /api/alerts/:id/acknowledge
WS   /ws/factory
```

Example machine command:

```json
{
  "command": "REDUCE_LOAD",
  "value": 55
}
```

Example 10000x request:

```json
{
  "speed": 10000,
  "paused": false
}
```

The WebSocket factory snapshot should match `FactoryState` and include the backend-owned machine, alert, `aiMessages`, event, maintenance and technician state. `WebSocketFactoryBackend` normalizes a missing `aiMessages` array to `[]`, so the UI remains compatible while the real AI pipeline is added. If your real Rust/API route names differ, adapt `WebSocketFactoryBackend.ts`; the Phaser world/UI should not need a rewrite.

## Source layout

```text
frontend/
├── assets/
│   ├── audio/                 original generated placeholder sounds
│   └── *.png                  original placeholder pixel art
├── src/
│   ├── backend/               backend contract, mock and WS/HTTP adapters
│   ├── config/                world, machine layout and status visuals
│   ├── entities/              player, machine and technician views
│   ├── models/                factory, machine, alerts, AI messages, events, maintenance
│   ├── scenes/                boot, factory and UI scenes
│   ├── ui/                    phone, AI assistant/queue, maps, audio, panels, alerts, time controls
│   ├── main.ts
│   └── styles.css
├── .env.example
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Asset notes

All PNG artwork in `assets/` and WAV placeholder sounds in `assets/audio/` were created specifically for this frontend. No Pokémon or other copyrighted game assets/audio are included. See `assets/ATTRIBUTION.txt` and `assets/audio/README.txt`.

## Important integration notes

- Machine IDs and positions are stable and defined once in `src/config/machineLayout.ts`; the maps reuse this data rather than duplicating layout coordinates.
- `simulationDay` is provided by `FactoryState`; the UI no longer guesses a fixed simulation epoch.
- `OFFLINE` means communications unavailable and does not imply that the physical machine stopped.
- A normal `STOPPED` machine uses a blue-gray status; red is reserved for actual danger/fault states.
- Requesting maintenance does not instantly repair a machine.
- Maintenance completion does not automatically restart a machine.
- The browser never connects directly to TimescaleDB.
- No C++, Rust gateway, PLC, AI, database, or simulator directories are included in this package.

### SYSTEM alerts vs AI assistant messages

These are intentionally separate presentation channels.

- **SYSTEM alerts** remain deterministic current operational/controller/backend conditions such as over-temperature, communication loss, motor faults, emergency stops, or cooling faults. They keep the existing alert styling and lifecycle.
- **AI messages** are backend-provided predictions, anomaly findings, recommendations, or reported AI decisions. They appear through the pixel-art AI assistant and remain accessible in the phone's `AI` tab.

The AI presentation model is `src/models/AIMessage.ts`:

```ts
interface AIMessage {
  id: string;
  machineId?: number;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  kind: 'PREDICTION' | 'RECOMMENDATION' | 'DECISION';
  title: string;
  message: string;
  recommendedAction?: string;
  confidence?: number;
  timestamp: string;
  prominent?: boolean;
}
```

`AIMessageManager` only detects newly received message IDs, queues prominent messages, and hands them to `AIAssistantUI`. It does **not** calculate failure risk, inspect telemetry thresholds, or invent ML output. Mock AI content is created only inside `MockFactoryBackend`; later the real Python/Rust/backend pipeline can populate `FactoryState.aiMessages` directly.

`kind: 'DECISION'` means a backend-reported AI decision/action. The frontend never upgrades a prediction or recommendation into a claimed executed action on its own.
