// -----------------------------------------------------------------------------
// Standalone probe, run on a computer (no Gladys needed):
//
//   MEARI_EMAIL=you@example.com MEARI_PASSWORD='...' node scripts/probe.js
//
// Optional: MEARI_PROFILE (iegeek), MEARI_COUNTRY (FR), MEARI_PHONE (33).
//
// It logs in, lists the cameras with their cloud category, reads battery and
// settings, dumps the full IoT model and a read-only capability scan (for the
// live / on-demand-snapshot feasibility work, see docs/live-feasibility.md),
// then listens to alarms (push + polling) and prints the RAW alarm type of
// each one. Press the doorbell button: the printed type is the one to map in
// src/meari/events.js if it is not reported as "doorbell".
//
// Everything here is read-only and never wakes the camera: it reads the cloud
// device record and the server-cached IoT model only. No awaken, no stream, no
// IoT set.
// -----------------------------------------------------------------------------

import { MeariClient } from '../src/meari/client.js';
import { AlarmListener } from '../src/meari/listener.js';
import { parseAlarmEvent } from '../src/meari/events.js';

const { MEARI_EMAIL, MEARI_PASSWORD } = process.env;
if (!MEARI_EMAIL || !MEARI_PASSWORD) {
  console.error('Set MEARI_EMAIL and MEARI_PASSWORD.');
  process.exit(2);
}

const client = new MeariClient({
  email: MEARI_EMAIL,
  password: MEARI_PASSWORD,
  appProfile: process.env.MEARI_PROFILE ?? 'iegeek',
  countryCode: process.env.MEARI_COUNTRY ?? 'FR',
  phoneCode: process.env.MEARI_PHONE ?? '33',
});

await client.login();
console.log(`Logged in. API ${client.apiServer}, MQTT ${client.mqttHost}:${client.mqttPort}`);

for (const camera of client.cameras()) {
  console.log(
    `\n${camera.deviceName} — category=${camera._category} devTypeID=${camera.devTypeID} model=${camera.deviceModel ?? '?'}`,
  );
  try {
    console.log('  battery:', await client.getBatteryInfo(camera.snNum));
  } catch (err) {
    console.log('  battery: unavailable', err.message);
  }
  try {
    const iot = await client.getIotConfig(camera.snNum);
    console.log('  settings (106 motion, 108 person, 150 PIR, 103 LED):', {
      106: iot['106'],
      108: iot['108'],
      150: iot['150'],
      103: iot['103'],
    });
    // Full IoT model: look here for any snapshot/capture/stream trigger code
    // the integration could use (see docs/live-feasibility.md).
    console.log('  full IoT model:', iot);
  } catch (err) {
    console.log('  settings: unavailable', err.message);
  }

  // Capability scan for the live/snapshot feasibility work (read-only: this only
  // reads the cloud device record and the server-cached IoT model, it never
  // wakes the camera). Shows whether the on-demand wake path is reachable
  // (deviceSignature present, P2P transport) and surfaces any field whose name
  // hints at a stream, capture, wake or thumbnail capability. Serials, tokens
  // and signatures are masked, never printed.
  const mask = (k) => /signature|token|secret|^sn|serial|licen|key$/i.test(k);
  const hint = /p2p|ppcs|stream|snap|capt|awak|wake|url|rtsp|flv|hls|live|pic|thumb|preview|tp$/i;
  const fields = {};
  for (const k of Object.keys(camera).filter((k) => hint.test(k))) {
    fields[k] = mask(k) ? (camera[k] ? '<present>' : '<empty>') : camera[k];
  }
  console.log('  capability fields:', fields);
  console.log(
    '  wake prerequisites:',
    `deviceSignature=${camera.deviceSignature ? 'present' : 'ABSENT'}`,
    `openapi=${client.openapiServer ? 'set' : 'MISSING'}`,
  );
}

// Print every alarm, including the types the integration ignores.
const listener = new AlarmListener({ client, onAlarm: () => {} });
const original = listener.handlePayload.bind(listener);
listener.handlePayload = async (payload, source) => {
  const event = parseAlarmEvent(payload);
  if (event) {
    console.log(
      `${new Date().toISOString()} [${source}] type=${event.alarmType} (${event.alarmName}) -> ${event.kind}` +
        ` device=${event.deviceId || event.licenseId} image=${event.imageUrl ? 'yes' : 'no'}`,
    );
  }
  return original(payload, source);
};
listener.start();
console.log('\nListening for alarms (Ctrl+C to stop)...');
