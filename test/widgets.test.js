import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import jpeg from 'jpeg-js';
import { validateWidgetContent, validateWidgetImage } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MeariClient } from '../src/meari/client.js';
import { Runtime } from '../src/runtime.js';
import { cameraIds } from '../src/camera.js';
import { DoorbellHistory, MAX_PER_CAMERA, parseEventTime } from '../src/history.js';
import { formatAge, formatDay, registerWidgets } from '../src/widgets.js';
import { createFakeCloud } from './fakeCloud.js';

const CONFIG = { email: 'v@example.com', password: 'pa$$' };

function makeJpeg(shade = 120) {
  const frame = { width: 64, height: 36, data: Buffer.alloc(64 * 36 * 4, shade) };
  return Buffer.from(jpeg.encode(frame, 80).data);
}

/** The .jpgx3 obfuscation the cloud applies to battery-camera snapshots. */
function obfuscate(buf, sn) {
  const key = Buffer.from(crypto.createHash('md5').update(`${sn}|${sn.length}|meari.stream`).digest('hex'));
  const out = Buffer.from(buf);
  for (let i = 0; i < Math.min(1024, out.length); i += 1) out[i] ^= key[i % key.length];
  return out;
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function setup(cloudOptions = {}, dataDir = null) {
  const cloud = createFakeCloud(cloudOptions);
  const gladys = createFakeGladys();
  const runtime = new Runtime(gladys, {
    createClient: (config) => new MeariClient({ email: config.email, password: config.password, fetch: cloud.fetch }),
    createListener: () => ({ start() {}, stop() {} }),
    dataDir,
  });
  registerWidgets(gladys, runtime);
  return { cloud, gladys, runtime };
}

test('parseEventTime understands the cloud formats', () => {
  assert.equal(parseEventTime({ eventTime: 1760000000 }), 1760000000000);
  assert.equal(parseEventTime({ eventTime: '1760000000123' }), 1760000000123);
  assert.equal(parseEventTime({ eventTime: '20261018013500' }), new Date(2026, 9, 18, 1, 35, 0).getTime());
  assert.equal(parseEventTime({ devLocalTime: '2026-10-18 01:35:00' }), new Date(2026, 9, 18, 1, 35, 0).getTime());
  assert.equal(parseEventTime({ eventTime: 'garbage' }), null);
  assert.equal(parseEventTime({}), null);
});

test('history persists, merges duplicates and keeps the last presses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iegeek-'));
  try {
    const history = new DoorbellHistory(dir);
    const t0 = Date.UTC(2026, 9, 18, 10, 0, 0);
    assert.equal(history.add({ deviceId: '1', at: t0 }), true);
    // Same press seen again (event log, 8 s apart, with its picture).
    assert.equal(history.add({ id: 'msg-1', deviceId: '1', at: t0 + 8000, image: 'QUJD' }), true);
    assert.equal(history.entries.length, 1);
    const key = history.entries[0].imageKey;
    assert.match(key, /^ring-[a-z0-9-]+$/);

    for (let i = 1; i <= MAX_PER_CAMERA + 2; i += 1) {
      history.add({ deviceId: '1', at: t0 + i * 3_600_000, image: 'REVG' });
    }
    assert.equal(history.entries.length, MAX_PER_CAMERA);

    const reloaded = new DoorbellHistory(dir);
    assert.equal(reloaded.latest(5).length, 5);
    assert.equal(reloaded.latest(1)[0].at, t0 + (MAX_PER_CAMERA + 2) * 3_600_000);
    assert.equal(reloaded.image(reloaded.latest(1)[0].imageKey), 'REVG');
    assert.equal(reloaded.image(key), null, 'pruned picture removed from disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('date labels', () => {
  const now = new Date(2026, 9, 18, 12, 0, 0).getTime();
  assert.equal(formatDay(now - 3_600_000, 'fr', now), 'Aujourd’hui');
  assert.equal(formatDay(now - 86_400_000, 'en', now), 'Yesterday');
  assert.match(formatDay(now - 3 * 86_400_000, 'fr', now), /^Jeudi 15 octobre$/);
  assert.equal(formatAge(now - 5 * 60_000, now).fr, 'il y a 5 min');
});

test('a press without picture, then its picture: history widget with image', async () => {
  const { gladys, runtime } = setup();
  await runtime.applyConfig(CONFIG);
  const doorbell = runtime.cameras().find((c) => c.deviceID === 1001);

  const empty = await gladys.fake.widgetGet('doorbell_history');
  assert.deepEqual(validateWidgetContent(empty.data.content), []);
  assert.match(empty.data.content.components[0].text.fr, /Aucun appui/);

  await runtime.handleAlarm(doorbell, { kind: 'doorbell', eventId: '', raw: {} }, null);
  await runtime.handleAlarm(doorbell, { kind: 'doorbell', repeat: true, eventId: 'm9', raw: {} }, makeJpeg());

  assert.equal(gladys.fake.sceneEvents.filter((e) => e.key === 'doorbell_pressed').length, 1, 'one ring');
  assert.ok(gladys.fake.widgetRefreshes.includes('doorbell_history'));

  const ack = await gladys.fake.widgetGet('doorbell_history', { language: 'fr' });
  const content = ack.data.content;
  assert.deepEqual(validateWidgetContent(content), []);
  const [list] = content.components;
  assert.equal(list.type, 'card-list');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].subtitle, 'Aujourd’hui');
  assert.match(list.items[0].title, /^\d\d:\d\d$/);

  const image = await gladys.fake.widgetGetImage(list.items[0].image);
  assert.equal(image.success, true);
  assert.deepEqual(validateWidgetImage(image.data.image), []);
  runtime.stop();
});

test('startup rebuilds the history and the camera picture from the cloud log', async () => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const day = (d) => stamp(d).slice(0, 8);
  const sn = 'XXXXDOORBELL01';
  const cloud = {
    events: {},
    images: { '/img/a.jpgx3': obfuscate(makeJpeg(200), sn), '/img/b.jpgx3': obfuscate(makeJpeg(60), sn) },
  };
  const { gladys, runtime, cloud: fake } = setup(cloud);
  // The fake serves one log per device: switch it by requested day.
  const original = fake.fetch;
  const logs = {
    [day(now)]: [{ msgID: 't1', eventType: 3, eventTime: stamp(now), imageUrl: 'https://cdn.example/img/a.jpgx3' }],
    [day(yesterday)]: [
      { msgID: 'y2', eventType: 2, eventTime: stamp(yesterday) },
      { msgID: 'y1', eventType: 3, eventTime: stamp(new Date(yesterday.getTime() - 60_000)), imageUrl: 'https://cdn.example/img/b.jpgx3' },
    ],
  };
  runtime.createClient = (config) =>
    new MeariClient({
      email: config.email,
      password: config.password,
      fetch: async (url, init) => {
        const u = new URL(url);
        if (u.pathname === '/v3/app/event/list') {
          fake.state.events[u.searchParams.get('deviceID')] =
            u.searchParams.get('deviceID') === '1001' ? (logs[u.searchParams.get('day')] ?? []) : [];
        }
        return original(url, init);
      },
    });
  await runtime.applyConfig(CONFIG);
  await runtime.seedFromCloud();

  const presses = runtime.history.latest(5);
  assert.deepEqual(
    presses.map((p) => Boolean(p.imageKey)),
    [true, true],
  );

  const ack = await gladys.fake.widgetGet('camera_view', { language: 'fr' });
  const content = ack.data.content;
  assert.deepEqual(validateWidgetContent(content), []);
  const image = content.components.find((c) => c.type === 'image');
  assert.ok(image, 'camera picture shown');
  const bytes = await gladys.fake.widgetGetImage(image.key);
  assert.deepEqual(validateWidgetImage(bytes.data.image), []);
  // The doorbell is picked by default, and its battery tile is live.
  const battery = content.components.find((c) => c.type === 'value' && c.icon === 'battery');
  assert.equal(battery.device_feature, cameraIds(gladys, runtime.cameras()[0]).feature('battery'));
  runtime.stop();
});

test('camera widget: empty state, then the refresh button finds a newer picture', async () => {
  const sn = 'XXXXGARDEN0002';
  const { gladys, runtime, cloud } = setup({ images: { '/img/c.jpgx3': obfuscate(makeJpeg(90), sn) } });
  await runtime.applyConfig(CONFIG);
  const garden = runtime.cameras().find((c) => c.deviceID === 1002);
  const settings = { device: cameraIds(gladys, garden).device };

  let ack = await gladys.fake.widgetGet('camera_view', { settings });
  assert.deepEqual(validateWidgetContent(ack.data.content), []);
  assert.ok(!ack.data.content.components.some((c) => c.type === 'image'));

  const none = await gladys.fake.widgetAction('camera_view', 'refresh', { device: settings.device }, { settings });
  assert.match(none.data.message.fr ?? none.data.message, /Pas d’image/);

  cloud.state.events[1002] = [
    { msgID: 'c1', eventType: 20, eventTime: stamp(new Date()), imageUrl: 'https://cdn.example/img/c.jpgx3' },
  ];
  const found = await gladys.fake.widgetAction('camera_view', 'refresh', { device: settings.device }, { settings });
  assert.match(found.data.message.fr ?? found.data.message, /Nouvelle image/);
  ack = await gladys.fake.widgetGet('camera_view', { settings });
  assert.ok(ack.data.content.components.some((c) => c.type === 'image'));
  assert.equal(gladys.fake.cameraImages.length, 1, 'the camera feature got it too');
  runtime.stop();
});
