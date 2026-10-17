import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAlarm, eventLogId, parseAlarmEvent } from '../src/meari/events.js';

test('parses a flat event-log entry', () => {
  const event = parseAlarmEvent({ deviceID: 42, eventType: 2, msgID: 'm1' });
  assert.equal(event.kind, 'motion');
  assert.equal(event.alarmName, 'Motion');
  assert.equal(event.deviceId, '42');
  assert.equal(event.person, false);
});

test('parses nested MQTT payloads (params/data wrappers) from a Buffer', () => {
  const payload = Buffer.from(
    JSON.stringify({ event: 'alarm', params: { data: { alarmType: '20', snNum: 'SN9', deviceId: '7' } } }),
  );
  const event = parseAlarmEvent(payload);
  assert.equal(event.kind, 'motion');
  assert.equal(event.person, true);
  assert.equal(event.deviceId, '7');
  assert.equal(event.licenseId, 'SN9');
});

test('a doorbell press wins over a motion in the same payload', () => {
  const event = parseAlarmEvent({ items: [{ eventType: 2, deviceID: 1 }, { eventType: 3, deviceID: 1 }] });
  assert.equal(event.kind, 'doorbell');
  assert.equal(event.alarmName, 'Visitor');
});

test('unknown alarm types are reported as "other", never as motion', () => {
  assert.equal(parseAlarmEvent({ eventType: 21, deviceID: 1 }).kind, 'other');
  assert.equal(parseAlarmEvent({ eventType: 'x', deviceID: 1 }).kind, 'other');
  assert.equal(classifyAlarm(10), 'other');
  assert.equal(classifyAlarm(9), 'doorbell');
});

test('finds the snapshot URL anywhere in the payload', () => {
  const event = parseAlarmEvent({ eventType: 1, deviceID: 1, data: { pics: [{ imageUrl: 'https://x/y.jpgx3' }] } });
  assert.equal(event.imageUrl, 'https://x/y.jpgx3');
  assert.equal(parseAlarmEvent({ eventType: 1, imageUrl: 'ftp://nope' }).imageUrl, '');
});

test('rejects non-JSON or non-object payloads', () => {
  assert.equal(parseAlarmEvent('not json'), null);
  assert.equal(parseAlarmEvent('[1,2]'), null);
  assert.equal(parseAlarmEvent({ nothing: true }), null);
});

test('eventLogId prefers msgID', () => {
  assert.equal(eventLogId({ msgID: 5, eventTime: 'x' }), '5');
  assert.equal(eventLogId({ eventTime: '2026' }), '2026');
  assert.equal(eventLogId({}), '');
});
