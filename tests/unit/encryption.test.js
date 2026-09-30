'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { TEST_KEY, quiet } = require('./_helpers');

process.env.SANCTUARY_ENCRYPTION_KEY = TEST_KEY;
let restore;
before(() => { restore = quiet(); });
after(() => { restore(); });

const { encryption } = require('../../encryption');

const crypto = require('node:crypto');
const { EncryptionError } = require('../../encryption');

const V2_RE = /^enc:v2:([A-Za-z0-9_-]{1,16}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]+)$/;

// 竄改「解碼後」的第 n 個 byte，避免 base64url 末位補位 bit 造成假陰性
function tamperV2(ct, part, byteIdx) {
    const p = ct.split(':');
    const buf = Buffer.from(p[part], 'base64url');
    buf[byteIdx] ^= 0x01;
    p[part] = buf.toString('base64url');
    return p.join(':');
}

function withKeys(fn, { key, keyId, oldKeys } = {}) {
    const o = { key: encryption.encryptionKey, keyId: encryption.keyId, oldKeys: encryption.oldKeys };
    try {
        if (key !== undefined) encryption.encryptionKey = key;
        if (keyId !== undefined) encryption.keyId = keyId;
        if (oldKeys !== undefined) encryption.oldKeys = oldKeys;
        return fn();
    } finally {
        encryption.encryptionKey = o.key; encryption.keyId = o.keyId; encryption.oldKeys = o.oldKeys;
    }
}

function v1Encrypt(text, keyHex) {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    let e = c.update(text, 'utf8', 'hex'); e += c.final('hex');
    return `enc:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${e}`;
}

describe('encryption.encrypt / decrypt（v2）', () => {
    test('輸出格式為 enc:v2:<kid>:<b64url nonce12>:<b64url ct‖tag16>', () => {
        const out = encryption.encrypt('hello');
        const m = V2_RE.exec(out);
        assert.ok(m, `格式不符: ${out}`);
        assert.equal(m[1], 'k1');
        assert.equal(Buffer.from(m[3], 'base64url').length, 'hello'.length + 16);
    });

    test('round-trip：含中文、emoji、換行', () => {
        for (const s of ['hello', '你好，世界', '😀 emoji\n第二行', 'a'.repeat(5000)]) {
            assert.equal(encryption.decrypt(encryption.encrypt(s)), s);
        }
    });

    test('每次加密 nonce 不同，密文不同', () => {
        const a = encryption.encrypt('same'), b = encryption.encrypt('same');
        assert.notEqual(a, b);
        assert.notEqual(a.split(':')[3], b.split(':')[3]);
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

    test('fail-closed：加密失敗拋 EncryptionError，訊息不含明文', () => {
        const secret = 'TOP-SECRET-計畫-12345';
        withKeys(() => {
            assert.throws(() => encryption.encrypt(secret), (e) => {
                assert.ok(e instanceof EncryptionError);
                assert.equal(e.name, 'EncryptionError');
                assert.ok(!e.message.includes(secret));
                assert.ok(!String(e.stack).includes(secret));
                return true;
            });
        }, { key: 'zz' });
    });

    test('decrypt：未加密字串（無 enc: 字首）原樣回傳', () => {
        assert.equal(encryption.decrypt('plain text'), 'plain text');
    });

    test('decrypt：非字串／空值原樣回傳', () => {
        assert.equal(encryption.decrypt(null), null);
        assert.equal(encryption.decrypt(undefined), undefined);
        assert.equal(encryption.decrypt(''), '');
        assert.equal(encryption.decrypt(42), 42);
    });

    test('decrypt：格式錯誤 → null（無佔位字串）', () => {
        for (const bad of ['enc:', 'enc:aa:bb', 'enc:aa:bb:cc:dd', 'enc:v2:k1:x', 'enc:v2:k1:AAAA:BBBB',
                           'enc:v2:k1:!!!!:????', 'enc:v2:k1::', 'enc:v2:k1:' + 'A'.repeat(16) + ':' + 'A'.repeat(10)]) {
            assert.equal(encryption.decrypt(bad), null, bad);
        }
    });

    test('decrypt：竄改 nonce／密文／tag 任一 byte → null', () => {
        const ct = encryption.encrypt('hello world');
        assert.equal(encryption.decrypt(ct), 'hello world');
        for (let i = 0; i < 12; i++) assert.equal(encryption.decrypt(tamperV2(ct, 3, i)), null, `nonce[${i}]`);
        const dataLen = Buffer.from(ct.split(':')[4], 'base64url').length; // 11 + 16
        for (let i = 0; i < dataLen; i++) assert.equal(encryption.decrypt(tamperV2(ct, 4, i)), null, `data[${i}]`);
    });

    test('decrypt：竄改 kid → null（未知 kid）', () => {
        const p = encryption.encrypt('hello').split(':'); p[2] = 'zz';
        assert.equal(encryption.decrypt(p.join(':')), null);
    });

    test('decrypt：換了金鑰的舊密文 → null', () => {
        const out = encryption.encrypt('hello');
        withKeys(() => assert.equal(encryption.decrypt(out), null), { key: 'f'.repeat(64) });
    });

    test('decrypt：opts.silent 隻影響 log，回傳值不變', () => {
        assert.equal(encryption.decrypt('enc:aa:bb', { silent: true }), null);
        assert.equal(encryption.decrypt('enc:00:00:00', { silent: true }), null);
    });

    test('decryptForDisplay：失敗回 fallback，成功回明文', () => {
        assert.equal(encryption.decryptForDisplay('enc:aa:bb'), '（無法解密）');
        assert.equal(encryption.decryptForDisplay('enc:aa:bb', 'X'), 'X');
        assert.equal(encryption.decryptForDisplay(encryption.encrypt('ok')), 'ok');
    });
});

describe('encryption AAD', () => {
    test('aad 相符可解', () => {
        const ct = encryption.encrypt('內容', { aad: 'memories:content:42' });
        assert.equal(encryption.decrypt(ct, { aad: 'memories:content:42' }), '內容');
    });
    test('aad 不符 → null（密文不能在資料列間互換）', () => {
        const ct = encryption.encrypt('內容', { aad: 'memories:content:42' });
        assert.equal(encryption.decrypt(ct, { aad: 'memories:content:43' }), null);
    });
    test('加密帶 aad、解密缺少 aad → null', () => {
        const ct = encryption.encrypt('內容', { aad: 'memories:content:42' });
        assert.equal(encryption.decrypt(ct), null);
    });
    test('加密無 aad、解密給 aad → null', () => {
        assert.equal(encryption.decrypt(encryption.encrypt('內容'), { aad: 'x' }), null);
    });
});

describe('encryption 金鑰輪替 / v1 相容', () => {
    const OLD_KEY = 'a'.repeat(64);

    test('新加密使用目前 kid', () => {
        withKeys(() => {
            assert.ok(encryption.encrypt('x').startsWith('enc:v2:k2:'));
        }, { keyId: 'k2' });
    });

    test('舊 kid 的密文在輪替後仍可用 OLD 金鑰解開', () => {
        const oldKey = encryption.encryptionKey;
        const ct = encryption.encrypt('舊資料', { aad: 'a' });
        assert.ok(ct.startsWith('enc:v2:k1:'));
        withKeys(() => {
            assert.equal(encryption.decrypt(ct, { aad: 'a' }), '舊資料');
            const fresh = encryption.encrypt('新資料');
            assert.ok(fresh.startsWith('enc:v2:k2:'));
            assert.equal(encryption.decrypt(fresh), '新資料');
        }, { key: OLD_KEY, keyId: 'k2', oldKeys: { k1: oldKey } });
        // 沒有舊金鑰時解不開
        withKeys(() => assert.equal(encryption.decrypt(ct, { aad: 'a' }), null), { key: OLD_KEY, keyId: 'k2', oldKeys: {} });
    });

    test('v1 相容：目前金鑰可解 v1（無 aad）', () => {
        const v1 = v1Encrypt('舊格式', encryption.encryptionKey);
        assert.equal(encryption.decrypt(v1), '舊格式');
    });

    test('v1 相容：OLD 金鑰中任一把可解 v1', () => {
        const v1 = v1Encrypt('舊格式2', OLD_KEY);
        assert.equal(encryption.decrypt(v1), null);
        withKeys(() => assert.equal(encryption.decrypt(v1), '舊格式2'), { oldKeys: { x: 'b'.repeat(64), y: OLD_KEY } });
    });

    test('v1 竄改 → null', () => {
        const parts = v1Encrypt('hello', encryption.encryptionKey).split(':');
        parts[3] = (parts[3][0] === '0' ? '1' : '0') + parts[3].slice(1);
        assert.equal(encryption.decrypt(parts.join(':')), null);
    });

    test('rotate：舊金鑰 v2 → 目前金鑰 v2，內容與 aad 保持', () => {
        const oldKey = encryption.encryptionKey;
        const ct = encryption.encrypt('輪替我', { aad: 'row:1' });
        withKeys(() => {
            const r = encryption.rotate(ct, { aad: 'row:1' });
            assert.ok(r.startsWith('enc:v2:k2:'));
            assert.equal(encryption.decrypt(r, { aad: 'row:1' }), '輪替我');
            assert.equal(encryption.decrypt(r, { aad: 'row:2' }), null);
        }, { key: OLD_KEY, keyId: 'k2', oldKeys: { k1: oldKey } });
    });

    test('rotate：v1 → v2（可加上 aad）', () => {
        const v1 = v1Encrypt('v1 內容', encryption.encryptionKey);
        const r = encryption.rotate(v1, { aad: 't:c:9' });
        assert.ok(r.startsWith('enc:v2:'));
        assert.equal(encryption.decrypt(r, { aad: 't:c:9' }), 'v1 內容');
    });

    test('rotate：無法解密拋 EncryptionError；空值原樣回傳', () => {
        assert.throws(() => encryption.rotate('enc:aa:bb:cc'), EncryptionError);
        assert.throws(() => encryption.rotate(encryption.encrypt('x', { aad: 'a' }), { aad: 'b' }), EncryptionError);
        assert.equal(encryption.rotate(null), null);
        assert.equal(encryption.rotate(''), '');
    });
});

describe('encryption.isEncrypted', () => {
    test('enc: 字首為真，其餘為假', () => {
        assert.equal(encryption.isEncrypted('enc:a:b:c'), true);
        assert.equal(encryption.isEncrypted(encryption.encrypt('x')), true);
        assert.equal(encryption.isEncrypted('plain'), false);
        assert.equal(encryption.isEncrypted('ENC:a'), false);
    });

    test('非字串／空值一律回傳嚴格 boolean false', () => {
        assert.equal(encryption.isEncrypted(null), false);
        assert.equal(encryption.isEncrypted(undefined), false);
        assert.equal(encryption.isEncrypted(''), false);
        assert.equal(encryption.isEncrypted(5), false);
    });
});
