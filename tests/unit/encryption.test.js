'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { TEST_KEY, quiet } = require('./_helpers');

process.env.SANCTUARY_ENCRYPTION_KEY = TEST_KEY;
let restore;
before(() => { restore = quiet(); });
after(() => { restore(); });

const { encryption } = require('../../encryption');

describe('encryption.encrypt / decrypt（特性測試）', () => {
    test('輸出格式為 enc:<iv hex 32>:<tag hex 32>:<ct hex>', () => {
        const out = encryption.encrypt('hello');
        const m = /^enc:([0-9a-f]{32}):([0-9a-f]{32}):([0-9a-f]+)$/.exec(out);
        assert.ok(m, `格式不符: ${out}`);
        assert.equal(m[3].length, 'hello'.length * 2); // GCM 密文長度 = 明文位元組數
    });

    test('round-trip：含中文、emoji、換行', () => {
        for (const s of ['hello', '你好，世界', '😀 emoji\n第二行', 'a'.repeat(5000)]) {
            assert.equal(encryption.decrypt(encryption.encrypt(s)), s);
        }
    });

    test('每次加密 IV 不同，密文不同', () => {
        assert.notEqual(encryption.encrypt('same'), encryption.encrypt('same'));
    });

    test('非字串輸入原樣回傳', () => {
        assert.equal(encryption.encrypt(null), null);
        assert.equal(encryption.encrypt(undefined), undefined);
        assert.equal(encryption.encrypt(123), 123);
        const obj = { a: 1 };
        assert.equal(encryption.encrypt(obj), obj);
    });

    test('空字串原樣回傳（不加密）', () => {
        assert.equal(encryption.encrypt(''), '');
    });

    test('現況：fail-open —— 加密失敗時回傳明文（已知缺陷）', () => {
        const orig = encryption.encryptionKey;
        try {
            encryption.encryptionKey = 'zz'; // hex 解出 0 bytes → createCipheriv 丟錯
            assert.equal(encryption.encrypt('secret'), 'secret');
        } finally {
            encryption.encryptionKey = orig;
        }
    });

    test('decrypt：未加密字串（無 enc: 前綴）原樣回傳', () => {
        assert.equal(encryption.decrypt('plain text'), 'plain text');
    });

    test('decrypt：非字串／空值原樣回傳', () => {
        assert.equal(encryption.decrypt(null), null);
        assert.equal(encryption.decrypt(undefined), undefined);
        assert.equal(encryption.decrypt(''), '');
        assert.equal(encryption.decrypt(42), 42);
    });

    test('decrypt：格式錯誤（段數不是 3）→ [解密失败：格式错误]', () => {
        assert.equal(encryption.decrypt('enc:aa:bb'), '[解密失败：格式错误]');
        assert.equal(encryption.decrypt('enc:aa:bb:cc:dd'), '[解密失败：格式错误]');
        assert.equal(encryption.decrypt('enc:'), '[解密失败：格式错误]');
    });

    test('decrypt：密文被竄改（GCM 驗證失敗）→ [解密失败的消息]', () => {
        const parts = encryption.encrypt('hello').split(':');
        const ct = parts[3];
        parts[3] = (ct[0] === '0' ? '1' : '0') + ct.slice(1);
        assert.equal(encryption.decrypt(parts.join(':')), '[解密失败的消息]');
    });

    test('decrypt：換了金鑰的舊密文 → [解密失败的消息]', () => {
        const out = encryption.encrypt('hello');
        const orig = encryption.encryptionKey;
        try {
            encryption.encryptionKey = 'f'.repeat(64);
            assert.equal(encryption.decrypt(out), '[解密失败的消息]');
        } finally {
            encryption.encryptionKey = orig;
        }
    });

    test('decrypt：opts.silent 只影響 log，回傳值不變', () => {
        assert.equal(encryption.decrypt('enc:aa:bb', { silent: true }), '[解密失败：格式错误]');
        assert.equal(encryption.decrypt('enc:00:00:00', { silent: true }), '[解密失败的消息]');
    });
});

describe('encryption.isEncrypted', () => {
    test('enc: 前綴為真，其餘為假', () => {
        assert.equal(encryption.isEncrypted('enc:a:b:c'), true);
        assert.equal(encryption.isEncrypted(encryption.encrypt('x')), true);
        assert.equal(encryption.isEncrypted('plain'), false);
        assert.equal(encryption.isEncrypted('ENC:a'), false);
    });

    test('現況：非字串／空值回傳假值（null、undefined、\'\' 原值，不是嚴格 boolean）', () => {
        assert.equal(encryption.isEncrypted(null), null);
        assert.equal(encryption.isEncrypted(undefined), undefined);
        assert.equal(encryption.isEncrypted(''), '');
        assert.equal(encryption.isEncrypted(5), false);
    });
});
