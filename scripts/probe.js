// -----------------------------------------------------------------------------
// Standalone probe, run on a computer (no Gladys needed):
//
//   MEARI_EMAIL=you@example.com MEARI_PASSWORD='...' node scripts/probe.js
//
// Optional: MEARI_PROFILE (iegeek), MEARI_COUNTRY (FR), MEARI_PHONE (33).
//
// It logs in, lists the cameras with their cloud category, reads battery and
// settings, then listens to alarms (push + polling) and prints the RAW alarm
// type of each one. Press the doorbell button: the printed type is the one to
// map in src/meari/events.js if it is not reported as "doorbell".
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
  } catch (err) {
    console.log('  settings: unavailable', err.message);
  }
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
