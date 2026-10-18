# CLAUDE.md

Gladys Assistant **external integration** for the Meari cloud (apps ieGeek Cam,
CloudEdge, CloudPlus / CloudHome, ANRAN, Arenti, BoifunCam). Node.js ESM, no
build step, runs in its own sandboxed Docker container and talks to Gladys
through `@gladysassistant/integration-sdk` (0.15). Target device: ieGeek B411B
battery doorbell.

## Commands

```bash
npm install
npm test                      # node --test, 47 tests, never touch the network
npm run format && npm run lint
MEARI_EMAIL=… MEARI_PASSWORD='…' node scripts/probe.js   # real cloud, prints raw alarm types
.local/start-gladys-test.command   # rebuilds gladys-integration-meari:dev + starts the test Gladys
```

Test Gladys: http://localhost:1080 (container `gladys-meari-test`, data in
`~/gladys-meari-test-data`). The integration is installed there in developer
mode from the local image `gladys-integration-meari:dev` (manifest:
`.local/manifest-dev.json`). After a rebuild: Integrations → Meari →
Supervision → "Forcer la mise à jour".

## Architecture

```
index.js              SDK wiring only (handlers registered before connect())
src/runtime.js        cloud session, alarms -> states / scene events / images
src/camera.js         Gladys device model (features, external ids)
src/widgets.js        dashboard widgets camera_view, doorbell_history
src/history.js        doorbell press history, persisted in /data
src/image.js          fits snapshots under the 150 KB Gladys image budget (jpeg-js)
src/meari/client.js   Meari HTTP API: redirect, login, devices, battery, IoT, event log
src/meari/listener.js alarms: MQTT push + event-log polling (15 s), de-duplicated
src/meari/mqtt.js     minimal MQTT 3.1.1 subscriber over TLS
src/meari/events.js   alarm payload parsing (motion / doorbell / other)
src/meari/crypto.js   request signing, password encryption, .jpgx3 snapshot decoding
```

The Meari protocol is ported from Uxzylon/Ha-CloudPlus-Meari (MIT, credited
in README and LICENSE): check there first when the cloud behaves unexpectedly.

## Rules

- External ids are forever: `gladys.externalIds('camera', deviceID)` + feature
  keys in `FEATURE` (src/camera.js). Never rename a feature, scene trigger,
  widget or config key.
- Every feature must declare `min` and `max`, even the camera image: Gladys
  refuses null ones with HTTP 422 (the SDK fake does not catch it; a test does).
- Write only under `/data` (`DATA_DIR` outside the container). Never log
  passwords, tokens, serials or image URLs.
- Never wake a battery camera: battery and settings come from the cloud cache,
  images from alert snapshots.
- User-facing text is bilingual (en/fr): manifest, action messages, docs/en.md
  and docs/fr.md kept in sync. Every user-visible change adds a CHANGELOG line
  under `## [Unreleased]`.
- Unconfirmed on real hardware: the doorbell press alarm type (mapped to 3
  "Visitor" and 9 "Call" in src/meari/events.js) and the `eventTime` formats
  parsed in src/history.js. Unknown alarm types are logged as "Ignored alarm".
