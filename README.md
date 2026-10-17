# Gladys integration — Meari (ieGeek Cam, CloudEdge…)

External integration for [Gladys Assistant](https://gladysassistant.com) (5.1+) bringing the cameras and doorbells of the Meari cloud platform to Gladys — the apps ieGeek Cam, CloudEdge, CloudPlus / CloudHome, ANRAN, Arenti and BoifunCam: motion, doorbell press, battery, event snapshot, a few camera settings, and two scene triggers.

User documentation: [docs/fr.md](docs/fr.md) · [docs/en.md](docs/en.md).

## How it works

```
index.js            SDK wiring only
src/runtime.js      cloud session, alarms -> Gladys states / scene events / images
src/camera.js       Gladys device model (features, external ids)
src/meari/client.js Meari HTTP API (redirect, login, devices, battery, IoT settings, event log)
src/meari/listener.js alarms: MQTT push + event-log polling every 15 s, de-duplicated
src/meari/mqtt.js   minimal MQTT 3.1.1 subscriber over TLS (no dependency)
src/meari/events.js alarm payload parsing (motion / doorbell / other)
src/meari/crypto.js request signing, password/account encryption, .jpgx3 snapshot decoding
src/image.js        fits snapshots into the 150 KB Gladys image budget (jpeg-js)
src/history.js      doorbell press history, persisted in /data
src/widgets.js      dashboard widgets: camera_view, doorbell_history
scripts/probe.js    standalone probe: login, list cameras, print raw alarm types
```

## Test on a computer

```bash
npm install
npm test

# Talk to the real cloud, without Gladys (prints raw alarm types: press the doorbell)
MEARI_EMAIL=you@example.com MEARI_PASSWORD='...' node scripts/probe.js

# Against a Gladys test instance (integration installed in developer mode)
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="<selector>" \
DATA_DIR=./data LOG_LEVEL=debug npm start   # DATA_DIR: /data in the container
```

## Credits

The Meari protocol work (authentication, signing, MQTT topics, event log, snapshot obfuscation) is ported from [Uxzylon/Ha-CloudPlus-Meari](https://github.com/Uxzylon/Ha-CloudPlus-Meari), MIT licensed. Unofficial: not affiliated with Meari or the app vendors.
