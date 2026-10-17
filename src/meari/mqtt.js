// -----------------------------------------------------------------------------
// Minimal MQTT 3.1.1 client over TLS, subscribe-only.
//
// The Meari event broker is only used to RECEIVE alarm pushes, so a full MQTT
// library would be dead weight in a 256 MB sandbox: this covers CONNECT,
// SUBSCRIBE, incoming PUBLISH at QoS 0/1/2, keepalive pings and reconnection
// with backoff. No dependency besides node:tls.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import tls from 'node:tls';

const TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  PUBREC: 5,
  PUBREL: 6,
  PUBCOMP: 7,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

const CONNACK_REASONS = {
  1: 'unacceptable protocol version',
  2: 'identifier rejected',
  3: 'server unavailable',
  4: 'bad user name or password',
  5: 'not authorized',
};

function encodeLength(length) {
  const bytes = [];
  let x = length;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    bytes.push(byte);
  } while (x > 0);
  return Buffer.from(bytes);
}

function encodeString(str) {
  const data = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length);
  return Buffer.concat([len, data]);
}

export function packet(type, flags, body = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);
}

export function connectPacket({ clientId, username, password, keepalive, clean = true }) {
  let flags = clean ? 0x02 : 0;
  if (username !== undefined) flags |= 0x80;
  if (password !== undefined) flags |= 0x40;
  const ka = Buffer.alloc(2);
  ka.writeUInt16BE(keepalive);
  const parts = [encodeString('MQTT'), Buffer.from([4, flags]), ka, encodeString(clientId)];
  if (username !== undefined) parts.push(encodeString(username));
  if (password !== undefined) parts.push(encodeString(password));
  return packet(TYPE.CONNECT, 0, Buffer.concat(parts));
}

export function subscribePacket(packetId, topics, qos = 1) {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId);
  const parts = [id];
  for (const topic of topics) {
    parts.push(encodeString(topic), Buffer.from([qos]));
  }
  return packet(TYPE.SUBSCRIBE, 0x02, Buffer.concat(parts));
}

function idPacket(type, flags, packetId) {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId);
  return packet(type, flags, id);
}

/**
 * Split a byte stream into MQTT packets. Returns the complete packets and the
 * unconsumed remainder.
 */
export function readPackets(buffer) {
  const packets = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    let multiplier = 1;
    let length = 0;
    let pos = offset + 1;
    let complete = false;
    for (let i = 0; i < 4 && pos < buffer.length; i += 1) {
      const byte = buffer[pos];
      pos += 1;
      length += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      if ((byte & 0x80) === 0) {
        complete = true;
        break;
      }
    }
    if (!complete || pos + length > buffer.length) break;
    packets.push({
      type: buffer[offset] >> 4,
      flags: buffer[offset] & 0x0f,
      body: buffer.subarray(pos, pos + length),
    });
    offset = pos + length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export function parsePublish(flags, body) {
  const qos = (flags >> 1) & 0x03;
  const topicLength = body.readUInt16BE(0);
  const topic = body.subarray(2, 2 + topicLength).toString('utf8');
  let pos = 2 + topicLength;
  let packetId = null;
  if (qos > 0) {
    packetId = body.readUInt16BE(pos);
    pos += 2;
  }
  return { qos, topic, packetId, payload: Buffer.from(body.subarray(pos)) };
}

/**
 * Events: 'connect', 'message' (topic, payload), 'close', 'error' (err),
 * 'connack-refused' (reason).
 */
export class MqttSubscriber extends EventEmitter {
  constructor({
    host,
    port,
    clientId,
    username,
    password,
    topics,
    keepalive = 300,
    rejectUnauthorized = false,
    minDelayMs = 3000,
    maxDelayMs = 60_000,
    connect = tls.connect,
  }) {
    super();
    this.options = { host, port, clientId, keepalive, rejectUnauthorized };
    this.username = username;
    this.password = password;
    this.topics = topics;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.tlsConnect = connect;
    this.socket = null;
    this.stopped = true;
    this.delay = minDelayMs;
    this.timers = new Set();
    this.packetId = 1;
    this.pendingQos2 = new Set();
    this.connected = false;
  }

  setCredentials(username, password) {
    this.username = username;
    this.password = password;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#open();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    clearInterval(this.pingTimer);
    if (this.socket) {
      try {
        if (this.connected) this.socket.write(packet(TYPE.DISCONNECT, 0));
      } catch {
        // socket already gone
      }
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  #later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  #open() {
    const { host, port, rejectUnauthorized } = this.options;
    let buffer = Buffer.alloc(0);
    const socket = this.tlsConnect({ host, port, servername: host, rejectUnauthorized });
    this.socket = socket;

    socket.setTimeout?.(30_000, () => socket.destroy(new Error('MQTT connect timeout')));

    socket.once('secureConnect', () => {
      socket.setTimeout?.(0);
      socket.write(
        connectPacket({
          clientId: this.options.clientId,
          username: this.username,
          password: this.password,
          keepalive: this.options.keepalive,
        }),
      );
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { packets, rest } = readPackets(buffer);
      buffer = Buffer.from(rest);
      for (const p of packets) this.#handle(socket, p);
    });

    socket.on('error', (err) => this.emit('error', err));

    socket.on('close', () => {
      clearInterval(this.pingTimer);
      const wasConnected = this.connected;
      this.connected = false;
      if (this.socket === socket) this.socket = null;
      this.emit('close', wasConnected);
      if (this.stopped) return;
      const wait = this.delay;
      this.delay = Math.min(this.delay * 2, this.maxDelayMs);
      this.#later(() => {
        if (!this.stopped) this.#open();
      }, wait);
    });
  }

  #handle(socket, p) {
    switch (p.type) {
      case TYPE.CONNACK: {
        const code = p.body[1];
        if (code !== 0) {
          this.emit('connack-refused', CONNACK_REASONS[code] ?? `code ${code}`);
          socket.destroy();
          return;
        }
        this.connected = true;
        this.delay = this.minDelayMs;
        socket.write(subscribePacket(this.#nextId(), this.topics, 1));
        const pingEvery = Math.max(10, this.options.keepalive * 0.75) * 1000;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          try {
            socket.write(packet(TYPE.PINGREQ, 0));
          } catch {
            socket.destroy();
          }
        }, pingEvery);
        this.pingTimer.unref?.();
        this.emit('connect');
        return;
      }
      case TYPE.PUBLISH: {
        const msg = parsePublish(p.flags, p.body);
        if (msg.qos === 1) {
          socket.write(idPacket(TYPE.PUBACK, 0, msg.packetId));
        } else if (msg.qos === 2) {
          socket.write(idPacket(TYPE.PUBREC, 0, msg.packetId));
          // QoS 2: deliver once, even if the broker re-sends before PUBREL.
          if (this.pendingQos2.has(msg.packetId)) return;
          this.pendingQos2.add(msg.packetId);
        }
        this.emit('message', msg.topic, msg.payload);
        return;
      }
      case TYPE.PUBREL: {
        const id = p.body.readUInt16BE(0);
        this.pendingQos2.delete(id);
        socket.write(idPacket(TYPE.PUBCOMP, 0, id));
        return;
      }
      default:
        // SUBACK, PINGRESP, PUBACK...: nothing to do.
        return;
    }
  }

  #nextId() {
    this.packetId = (this.packetId % 65535) + 1;
    return this.packetId;
  }
}
