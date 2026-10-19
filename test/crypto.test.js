import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  aesDecrypt,
  aesEncrypt,
  decodeEventSnapshot,
  decryptPlatformSignature,
  desEncrypt,
  encodeUserAccount,
  hmacSha1Base64,
} from '../src/meari/crypto.js';

// Reference vectors computed with OpenSSL (`openssl enc -des-cbc` /
// `-aes-128-cbc`) and Python's hmac, independently of this implementation.

test('desEncrypt matches single DES-CBC with the Meari key', () => {
  assert.equal(desEncrypt('secret'), 'vNWWbSb5hNg=');
});

test('encodeUserAccount derives the AES key from path, partner, ttid and time', () => {
  assert.equal(
    encodeUserAccount('vincent@example.com', '/meari/app/login', 1700000000000, '81', 'a'),
    'hhxkDfIHjewho1N0K/iPGEMmkdYmIaD1pp4WjG1CU9A=',
  );
});

test('hmacSha1Base64 matches Python hmac', () => {
  assert.equal(hmacSha1Base64('a=1&b=2', 'tok'), '6r9EhmGU5dY8Lgq1kW82itFfS5g=');
});

test('aesDecrypt reverses aesEncrypt, with or without base64 padding', () => {
  const key = '0123456789abcdef';
  const ct = aesEncrypt('hello meari', key);
  assert.equal(aesDecrypt(ct, key), 'hello meari');
  assert.equal(aesDecrypt(ct.replace(/=+$/, ''), key), 'hello meari');
});

test('decryptPlatformSignature recovers the OpenAPI credentials', () => {
  const userId = 123456;
  const expireTime = '1760000000';
  const key16 = Buffer.from(`${userId}81a${expireTime}`)
    .toString('base64')
    .replace(/=+$/, '')
    .slice(0, 16);
  const info = Buffer.from(JSON.stringify({ accessid: 'AID', accesskey: 'AKEY' })).toString(
    'base64',
  );
  const signature = aesEncrypt(`${info}-whatever`, key16);
  assert.deepEqual(
    decryptPlatformSignature(signature, { userId, partnerId: '81', ttid: 'a', expireTime }),
    { accessid: 'AID', accesskey: 'AKEY' },
  );
});

test('decodeEventSnapshot passes plain JPEGs through', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  assert.equal(decodeEventSnapshot(jpeg, 'SN'), jpeg);
});

test('decodeEventSnapshot reverses the .jpgx3 XOR of the first 1024 bytes', () => {
  const sn = 'ABC123456';
  const plain = Buffer.alloc(3000, 7);
  plain[0] = 0xff;
  plain[1] = 0xd8;
  plain[2] = 0xff;
  const key = Buffer.from(
    crypto.createHash('md5').update(`${sn}|${sn.length}|meari.stream`).digest('hex'),
  );
  // Independent check of the key derivation (Python hashlib).
  assert.equal(key.toString(), '8c75db5835b81bf5eb28ca16d0fb3a67');
  const obfuscated = Buffer.from(plain);
  for (let i = 0; i < 1024; i += 1) obfuscated[i] ^= key[i % key.length];
  assert.deepEqual(decodeEventSnapshot(obfuscated, sn), plain);
  assert.equal(decodeEventSnapshot(obfuscated, 'WRONGSERIAL'), null);
  assert.equal(decodeEventSnapshot(obfuscated, ''), null);
});
