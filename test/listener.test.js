import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeariClient } from '../src/meari/client.js';
import { AlarmListener, MERGE_WINDOW_MS } from '../src/meari/listener.js';
import { createFakeCloud } from './fakeCloud.js';

async function setup(events = {}) {
  const cloud = createFakeCloud({ events });
  const client = new MeariClient({ email: 'v@e.com', password: 'pa$$', fetch: cloud.fetch });
  await client.login();
  const alarms = [];
  let now = 1_000_000;
  const listener = new AlarmListener({
    client,
    useMqtt: false,
    now: () => now,
    onAlarm: (camera, event) => alarms.push([camera.deviceID, event.kind, event.source]),
  });
  return { cloud, listener, alarms, advance: (ms) => (now += ms) };
}

test('the first poll seeds existing events without replaying them', async () => {
  const { listener, alarms, cloud, advance } = await setup({ 1001: [{ msgID: 'old', eventType: 3 }] });
  await listener.pollOnce();
  assert.deepEqual(alarms, []);

  cloud.state.events[1001] = [{ msgID: 'new', eventType: 3 }, { msgID: 'old', eventType: 3 }];
  advance(15_000);
  await listener.pollOnce();
  assert.deepEqual(alarms, [[1001, 'doorbell', 'poll']]);
});

test('an alarm pushed then polled is dispatched once', async () => {
  const { listener, alarms, cloud, advance } = await setup();
  await listener.pollOnce();
  assert.equal(await listener.handlePayload({ deviceID: '1001', eventType: 3, msgID: 'p1' }, 'push'), true);
  cloud.state.events[1001] = [{ msgID: 'p1', eventType: 3 }];
  advance(10_000);
  await listener.pollOnce();
  assert.deepEqual(alarms, [[1001, 'doorbell', 'push']]);

  // A new press after the window is a new alarm.
  advance(MERGE_WINDOW_MS);
  await listener.handlePayload({ deviceID: '1001', eventType: 3 }, 'push');
  assert.equal(alarms.length, 2);
});

test('repeated motions are forwarded flagged as repeat', async () => {
  const { listener } = await setup();
  const seen = [];
  listener.onAlarm = (_camera, event) => seen.push(event.repeat);
  await listener.handlePayload({ deviceID: '1002', eventType: 2 }, 'push');
  await listener.handlePayload({ deviceID: '1002', eventType: 1 }, 'poll');
  assert.deepEqual(seen, [false, true]);
});

test('alarms of unknown cameras or unknown types are ignored', async () => {
  const { listener, alarms } = await setup();
  assert.equal(await listener.handlePayload({ deviceID: '999', eventType: 2 }, 'push'), false);
  assert.equal(await listener.handlePayload({ deviceID: '1001', eventType: 21 }, 'push'), false);
  // Routed by serial when the payload has no device id.
  assert.equal(await listener.handlePayload({ snNum: 'XXXXGARDEN0002', alarmType: 20 }, 'push'), true);
  assert.deepEqual(alarms, [[1002, 'motion', 'push']]);
});

test('MQTT uses the user id as client id and the account topic', async () => {
  const cloud = createFakeCloud();
  const client = new MeariClient({ email: 'v@e.com', password: 'pa$$', fetch: cloud.fetch });
  await client.login();
  let options = null;
  const fake = { on() {}, start() {}, stop() {}, setCredentials() {} };
  const listener = new AlarmListener({
    client,
    onAlarm: () => {},
    mqttFactory: (opts) => {
      options = opts;
      return fake;
    },
  });
  listener.start();
  listener.stop();
  assert.equal(options.clientId, '987654');
  assert.equal(options.username, 'ACCESS');
  assert.equal(options.password, 'mqtt-sig');
  assert.deepEqual(options.topics, ['$bsssvr/iot/987654/987654/event/update/accepted']);
});
