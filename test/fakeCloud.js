// An in-memory Meari cloud for the tests: a `fetch` implementation that
// answers the endpoints the client uses and checks the request signatures.
// No network is ever touched.

import { aesEncrypt, desEncrypt, hmacSha1Base64 } from '../src/meari/crypto.js';

export const USER_TOKEN = 'user-token-abc';
export const USER_ID = 987654;
export const ACCESS_KEY = 'access-key-xyz';

export const CAMERAS = [
  { deviceID: 1001, snNum: 'XXXXDOORBELL01', deviceName: 'Porte', deviceSignature: 'sig1', t: 5 },
  { deviceID: 1002, snNum: 'XXXXGARDEN0002', deviceName: 'Jardin', deviceSignature: 'sig2' },
];

function json(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function checkSignature(params) {
  const { signature, ...rest } = params;
  const content = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');
  if (hmacSha1Base64(content, USER_TOKEN) !== signature) {
    throw new Error('bad signature');
  }
}

export function createFakeCloud({
  password = 'pa$$',
  events = {},
  iot = {},
  battery = {},
  images = {},
} = {}) {
  const calls = [];
  const state = { events, iot, battery, images, sets: [], password };

  const platformSignature = (() => {
    const expireTime = '1999999999';
    const key16 = Buffer.from(`${USER_ID}81a${expireTime}`)
      .toString('base64')
      .replace(/=+$/, '')
      .slice(0, 16);
    const info = Buffer.from(
      JSON.stringify({ accessid: 'ACCESS', accesskey: ACCESS_KEY }),
    ).toString('base64');
    return { signature: aesEncrypt(`${info}-x`, key16), expireTime };
  })();

  async function fetchImpl(url, init = {}) {
    if (state.networkDown) {
      throw new TypeError('fetch failed');
    }
    const u = new URL(url);
    const params = Object.fromEntries(
      init.method === 'POST' ? new URLSearchParams(init.body) : u.searchParams,
    );
    calls.push({ path: u.pathname, params, headers: init.headers });

    switch (u.pathname) {
      case '/ppstrongs/redirect':
        return json({
          resultCode: '1001',
          result: { apiServer: 'https://apis-eu-frankfurt.cloudedge360.com' },
        });
      case '/meari/app/login':
        if (params.password !== desEncrypt(state.password)) {
          return json({ resultCode: '1004', resultMsg: 'password error' });
        }
        return json({ resultCode: '1001', result: { userID: USER_ID, userToken: USER_TOKEN } });
      case '/v2/app/config/pf/init':
        checkSignature(params);
        return json({
          resultCode: '1001',
          result: {
            pfApi: {
              mqtt: { host: 'events-euce.mearicloud.com', port: 8883 },
              mqttSignature: 'mqtt-sig',
              platform: platformSignature,
            },
          },
        });
      case '/v1/app/device/info/get':
        checkSignature(params);
        // A transient mid-session failure: the list call answers without the
        // success code (so no devices are collected), mimicking a flaky cloud.
        if (state.deviceListFails) {
          return json({ resultCode: '5000', resultMsg: 'temporary error' });
        }
        return json({
          resultCode: '1001',
          doorbell: [CAMERAS[0]],
          snap: [CAMERAS[1]],
          chime: [{ deviceID: 3, snNum: 'CHIME' }],
        });
      case '/v1/app/home/list':
        return json({ resultCode: '1001', result: { homes: [] } });
      case '/v3/app/event/list':
        checkSignature(params);
        return json({ resultCode: '1001', alertMsg: state.events[params.deviceID] ?? [] });
      case '/v2/app/iot/model/get/batch': {
        checkSignature(params);
        const sn = Object.keys(JSON.parse(params.snIdentifier))[0];
        return json({ resultCode: '1001', result: { [sn]: state.battery[sn] ?? {} } });
      }
      case '/openapi/device/config': {
        const expected = hmacSha1Base64(
          `GET\n\n\n${params.expires}\n/openapi/device/config\n${params.action}`,
          ACCESS_KEY,
        );
        if (params.signature !== expected || !params.token) {
          return json({ errid: 401, errstr: 'Authorization Failed' });
        }
        const body = JSON.parse(Buffer.from(params.params, 'base64').toString());
        if (params.action === 'set') {
          state.sets.push({ deviceid: params.deviceid, iot: body.iot });
          return json({ action: 'set' });
        }
        return json({ iot: state.iot[params.deviceid] ?? {} });
      }
      default: {
        const image = state.images[u.pathname];
        if (image) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              image.buffer.slice(image.byteOffset, image.byteOffset + image.length),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }
    }
  }

  return { fetch: fetchImpl, calls, state };
}
