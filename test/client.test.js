import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MeariAuthError,
  MeariClient,
  collectDevices,
  formatSn,
  meariTimestamp,
  passwordVariants,
} from '../src/meari/client.js';
import { createFakeCloud, USER_ID } from './fakeCloud.js';

const newClient = (cloud, password = 'pa$$') =>
  new MeariClient({ email: 'v@example.com', password, appProfile: 'iegeek', fetch: cloud.fetch });

test('full login: redirect, login, platform init, cameras', async () => {
  const cloud = createFakeCloud();
  const client = newClient(cloud);
  await client.login();
  assert.equal(client.userId, USER_ID);
  assert.equal(client.accessId, 'ACCESS');
  assert.equal(client.mqttHost, 'events-euce.mearicloud.com');
  assert.equal(client.mqttPort, 8883);
  assert.equal(client.mqttSignature, 'mqtt-sig');
  assert.equal(client.openapiServer, 'https://openapi-euce.mearicloud.com');
  // The chime is a device of the account, but not a camera.
  assert.deepEqual(
    client.cameras().map((c) => [c.deviceID, c._category]),
    [
      [1001, 'doorbell'],
      [1002, 'snap'],
    ],
  );
  const login = cloud.calls.find((c) => c.path === '/meari/app/login');
  assert.equal(login.params.sourceApp, '81', 'ieGeek identity');
  assert.ok(login.headers['X-Ca-Sign']);
});

test('a wrong password is an auth error', async () => {
  const cloud = createFakeCloud();
  await assert.rejects(newClient(cloud, 'nope').login(), MeariAuthError);
});

test('reads battery, reads and writes IoT settings through the OpenAPI', async () => {
  const cloud = createFakeCloud({
    battery: { XXXXDOORBELL01: { 154: { value: 87 }, 156: 0 } },
    iot: { DOORBELL01: { 106: 1, 150: 0 } },
  });
  const client = newClient(cloud);
  await client.login();
  assert.deepEqual(await client.getBatteryInfo('XXXXDOORBELL01'), { 154: 87, 156: 0 });
  assert.deepEqual(await client.getIotConfig('XXXXDOORBELL01'), { 106: 1, 150: 0 });
  await client.setIotValue('XXXXDOORBELL01', 106, 0);
  assert.deepEqual(cloud.state.sets, [{ deviceid: 'DOORBELL01', iot: { 106: 0 } }]);
  const config = cloud.calls.find((c) => c.path === '/openapi/device/config');
  assert.equal(config.params.token, 'sig1', 'per-device token');
  assert.equal(config.params.t, '5');
});

test('helpers', () => {
  assert.equal(formatSn('123456789'), '0000000123456789');
  assert.equal(formatSn('XXXXDOORBELL01'), 'DOORBELL01');
  assert.deepEqual(passwordVariants("it's"), ["it's", 'it\u2019s']);
  assert.match(meariTimestamp(new Date()), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}GMT[+-]\d\d:00$/);
  const devices = collectDevices({ result: { snap: [{ deviceID: 1, snNum: 'A' }], deviceList: [{ deviceID: 2, snNum: 'B', devTypeID: 5 }] } });
  assert.equal(devices.get('1')._category, 'snap');
  assert.equal(devices.get('2')._category, 'snap', 'devTypeID 5 = battery camera');
});
