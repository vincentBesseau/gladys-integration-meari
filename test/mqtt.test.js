import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  MqttSubscriber,
  connectPacket,
  packet,
  parsePublish,
  readPackets,
  subscribePacket,
} from '../src/meari/mqtt.js';

function publishPacket(topic, payload, qos, packetId) {
  const t = Buffer.from(topic);
  const parts = [Buffer.from([t.length >> 8, t.length & 0xff]), t];
  if (qos > 0) parts.push(Buffer.from([packetId >> 8, packetId & 0xff]));
  parts.push(Buffer.from(payload));
  return packet(3, qos << 1, Buffer.concat(parts));
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
  }
  write(buf) {
    this.written.push(...readPackets(buf).packets);
    return true;
  }
  destroy() {
    this.emit('close');
  }
  setTimeout() {}
}

test('CONNECT packet carries client id, credentials and keepalive', () => {
  const buf = connectPacket({ clientId: '123', username: 'u', password: 'p', keepalive: 300 });
  const [p] = readPackets(buf).packets;
  assert.equal(p.type, 1);
  assert.equal(p.body.subarray(2, 6).toString(), 'MQTT');
  assert.equal(p.body[6], 4); // protocol level 3.1.1
  assert.equal(p.body[7], 0xc2); // username + password + clean session
  assert.equal(p.body.readUInt16BE(8), 300);
});

test('readPackets keeps an incomplete packet for the next chunk', () => {
  const full = Buffer.concat([publishPacket('a/b', 'x'.repeat(200), 0), subscribePacket(1, ['t'])]);
  const first = readPackets(full.subarray(0, 50));
  assert.equal(first.packets.length, 0);
  const all = readPackets(full);
  assert.equal(all.packets.length, 2);
  const msg = parsePublish(all.packets[0].flags, all.packets[0].body);
  assert.equal(msg.topic, 'a/b');
  assert.equal(msg.payload.length, 200);
});

test('subscriber connects, subscribes and acknowledges QoS 1 and 2 messages', () => {
  const socket = new FakeSocket();
  const sub = new MqttSubscriber({
    host: 'h',
    port: 1,
    clientId: '42',
    username: 'u',
    password: 'p',
    topics: ['$bsssvr/iot/42/42/event/update/accepted'],
    connect: () => socket,
  });
  const messages = [];
  sub.on('message', (topic, payload) => messages.push([topic, payload.toString()]));
  sub.start();
  socket.emit('secureConnect');
  assert.equal(socket.written[0].type, 1, 'CONNECT sent');

  socket.emit('data', packet(2, 0, Buffer.from([0, 0])));
  assert.equal(sub.connected, true);
  const subscribe = socket.written[1];
  assert.equal(subscribe.type, 8);
  assert.match(subscribe.body.toString(), /event\/update\/accepted/);

  socket.emit('data', publishPacket('t', '{"a":1}', 1, 9));
  assert.equal(socket.written.at(-1).type, 4, 'PUBACK');

  // QoS 2: PUBREC, a re-delivery before PUBREL is not dispatched twice, PUBCOMP.
  socket.emit('data', publishPacket('t', '{"b":2}', 2, 10));
  socket.emit('data', publishPacket('t', '{"b":2}', 2, 10));
  assert.equal(socket.written.at(-1).type, 5, 'PUBREC');
  socket.emit('data', packet(6, 2, Buffer.from([0, 10])));
  assert.equal(socket.written.at(-1).type, 7, 'PUBCOMP');

  assert.deepEqual(messages, [
    ['t', '{"a":1}'],
    ['t', '{"b":2}'],
  ]);
  sub.stop();
});

test('a refused CONNACK is reported with its reason', () => {
  const socket = new FakeSocket();
  const sub = new MqttSubscriber({
    host: 'h',
    port: 1,
    clientId: '1',
    topics: ['t'],
    connect: () => socket,
  });
  let reason = null;
  sub.on('connack-refused', (r) => {
    reason = r;
    sub.stop();
  });
  sub.start();
  socket.emit('secureConnect');
  socket.emit('data', packet(2, 0, Buffer.from([0, 5])));
  assert.equal(reason, 'not authorized');
});
