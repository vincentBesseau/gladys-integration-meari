import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MeariClient } from '../src/meari/client.js';
import { Runtime } from '../src/runtime.js';
import { FEATURE, cameraIds } from '../src/camera.js';
import { fitJpeg } from '../src/image.js';
import { createFakeCloud } from './fakeCloud.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url)),
);
const CONFIG = { email: 'v@example.com', password: 'pa$$' };

function setup(cloudOptions = {}) {
  const cloud = createFakeCloud(cloudOptions);
  const gladys = createFakeGladys();
  const runtime = new Runtime(gladys, {
    createClient: (config) =>
      new MeariClient({ email: config.email, password: config.password, fetch: cloud.fetch }),
    // No timers nor sockets in the tests: alarms are injected by hand.
    createListener: () => ({ start() {}, stop() {} }),
    dataDir: null,
  });
  return { cloud, gladys, runtime };
}

test('without credentials, the status asks for them', async () => {
  const { gladys, runtime } = setup();
  await runtime.applyConfig({});
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /mot de passe/);
});

test('a refused login is reported, not retried', async () => {
  const { gladys, runtime } = setup();
  await runtime.applyConfig({ ...CONFIG, password: 'wrong' });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /Login refused/);
  assert.equal(runtime.retryTimer, null);
});

test('publishes one device per camera, accepted by Gladys', async () => {
  const { gladys, runtime } = setup({ iot: { DOORBELL01: { 106: 1, 150: 1 } } });
  await runtime.applyConfig(CONFIG);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const devices = gladys.fake.discoveredDevices;
  assert.equal(devices.length, 2);
  const doorbell = devices.find((d) => d.name === 'Porte');
  const keys = doorbell.features.map((f) => f.external_id.split(':').pop());
  assert.deepEqual(keys, [
    'image',
    'motion',
    'doorbell',
    'battery',
    'charging',
    'motion-detection',
    'pir',
  ]);
  const garden = devices.find((d) => d.name === 'Jardin');
  assert.ok(!garden.features.some((f) => f.category === 'doorbell'), 'no doorbell on a camera');
});

test('device feature names follow the configured device_language', async () => {
  const { gladys, runtime } = setup({ iot: { DOORBELL01: { 106: 1, 150: 1 } } });
  await runtime.applyConfig({ ...CONFIG, device_language: 'fr' });
  const doorbell = gladys.fake.discoveredDevices.find((d) => d.name === 'Porte');
  const nameByKey = Object.fromEntries(
    doorbell.features.map((f) => [f.external_id.split(':').pop(), f.name]),
  );
  assert.equal(nameByKey.motion, 'Mouvement');
  assert.equal(nameByKey.doorbell, 'Sonnette');
  assert.equal(nameByKey.battery, 'Batterie');
  assert.equal(nameByKey['motion-detection'], 'Détection de mouvement');
  // The cloud device name itself is not translated.
  assert.equal(doorbell.name, 'Porte');
});

test('every feature declares min and max (Gladys refuses null ones)', async () => {
  const { gladys, runtime } = setup({ iot: { DOORBELL01: { 106: 1, 108: 0, 150: 1, 103: 1 } } });
  await runtime.applyConfig({ ...CONFIG, force_doorbell: true });
  for (const device of gladys.fake.discoveredDevices) {
    for (const feature of device.features) {
      assert.equal(typeof feature.min, 'number', `${feature.name}: min`);
      assert.equal(typeof feature.max, 'number', `${feature.name}: max`);
    }
  }
});

test('force_doorbell adds the doorbell feature to every camera', async () => {
  const { gladys, runtime } = setup();
  await runtime.applyConfig({ ...CONFIG, force_doorbell: true });
  for (const device of gladys.fake.discoveredDevices) {
    assert.ok(device.features.some((f) => f.category === 'doorbell'));
  }
});

test('a doorbell press rings, fires the scene trigger, then resets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gladys, runtime } = setup();
  await runtime.applyConfig(CONFIG);
  const camera = runtime.cameras().find((c) => c.deviceID === 1001);
  const ids = cameraIds(gladys, camera);

  await runtime.handleAlarm(camera, { kind: 'doorbell' }, null);
  assert.deepEqual(gladys.fake.states.at(-1), {
    device_feature_external_id: ids.feature(FEATURE.DOORBELL),
    state: 1,
  });
  assert.deepEqual(gladys.fake.sceneEvents.at(-1), {
    key: 'doorbell_pressed',
    data: { device: ids.device },
  });

  t.mock.timers.tick(5_000);
  await new Promise(setImmediate);
  assert.equal(gladys.fake.states.at(-1).state, 0);
  runtime.stop();
});

test('motion: one scene event per detection, the state holds until the timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gladys, runtime } = setup();
  await runtime.applyConfig({ ...CONFIG, motion_timeout: 30 });
  const camera = runtime.cameras().find((c) => c.deviceID === 1002);
  const motionId = cameraIds(gladys, camera).feature(FEATURE.MOTION);

  await runtime.handleAlarm(camera, { kind: 'motion', person: true }, null);
  t.mock.timers.tick(20_000);
  await runtime.handleAlarm(camera, { kind: 'motion', person: false, repeat: true }, null);
  t.mock.timers.tick(20_000);
  await new Promise(setImmediate);
  const motionStates = gladys.fake.states.filter((s) => s.device_feature_external_id === motionId);
  assert.deepEqual(
    motionStates.map((s) => s.state),
    [1],
    'still active: the repeat extended it',
  );
  assert.equal(gladys.fake.sceneEvents.length, 1);
  assert.equal(gladys.fake.sceneEvents[0].data.target, 'person');

  t.mock.timers.tick(10_000);
  await new Promise(setImmediate);
  assert.equal(gladys.fake.states.at(-1).state, 0);
  runtime.stop();
});

test('scene trigger keys and data fields are declared in the manifest', () => {
  const triggers = Object.fromEntries(manifest.scene_triggers.map((t) => [t.key, t]));
  assert.ok(triggers.doorbell_pressed);
  assert.ok(triggers.motion_detected);
  const targets = triggers.motion_detected.fields
    .find((f) => f.key === 'target')
    .options.map((o) => o.value);
  assert.deepEqual(targets.sort(), ['motion', 'person']);
});

test('an event snapshot becomes the camera image (re-encoded under 150 KB)', async () => {
  const { gladys, runtime } = setup();
  await runtime.applyConfig(CONFIG);
  const camera = runtime.cameras()[0];
  const device = { external_id: cameraIds(gladys, camera).device };
  assert.throws(() => runtime.getImage(device), /No snapshot yet/);

  // A noisy 2K frame: far above the budget once encoded.
  const width = 2304;
  const height = 1296;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 7919) % 251;
  const big = Buffer.from(jpeg.encode({ width, height, data }, 95).data);
  assert.ok(big.length > 150 * 1024);

  await runtime.handleAlarm(camera, { kind: 'motion' }, big);
  const image = runtime.getImage(device);
  assert.match(image, /^image\/jpg;base64,/);
  assert.ok(image.length <= 150 * 1024);
  assert.equal(gladys.fake.cameraImages.length, 1);
  runtime.stop();
});

test('small JPEGs are sent untouched', () => {
  const frame = { width: 4, height: 4, data: Buffer.alloc(64, 128) };
  const small = Buffer.from(jpeg.encode(frame, 80).data);
  assert.equal(fitJpeg(small), `image/jpg;base64,${small.toString('base64')}`);
});

test('poll reads battery and settings; switches write to the camera', async () => {
  const { cloud, gladys, runtime } = setup({
    battery: { XXXXDOORBELL01: { 154: 64, 156: 1 } },
    iot: { DOORBELL01: { 106: 1 } },
  });
  await runtime.applyConfig(CONFIG);
  const camera = runtime.cameras().find((c) => c.deviceID === 1001);
  const ids = cameraIds(gladys, camera);
  const device = { external_id: ids.device };

  assert.equal(await runtime.poll(device), true);
  const byFeature = Object.fromEntries(
    gladys.fake.states.map((s) => [s.device_feature_external_id.split(':').pop(), s.state]),
  );
  assert.equal(byFeature.battery, 64);
  assert.equal(byFeature.charging, 1);
  assert.equal(byFeature['motion-detection'], 1);
  assert.equal(await runtime.poll(device), false, 'skipped until poll_frequency elapses');

  await runtime.setValue(device, { external_id: ids.feature(FEATURE.SWITCH_MOTION_DETECTION) }, 0);
  assert.deepEqual(cloud.state.sets.at(-1), { deviceid: 'DOORBELL01', iot: { 106: 0 } });
  await assert.rejects(
    runtime.setValue(device, { external_id: ids.feature(FEATURE.BATTERY) }, 1),
    /read-only/,
  );
  runtime.stop();
});

test('test_connection lists the cameras', async () => {
  const { runtime } = setup();
  await runtime.applyConfig(CONFIG);
  const message = await runtime.testConnection();
  assert.match(message.fr, /2 caméra\(s\).*Porte, Jardin/);
  runtime.stop();
});
