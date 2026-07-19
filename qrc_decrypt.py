"""
QQ 音樂 QRC 歌詞解密。

QRC 是 hex 字串 -> 3DES 解密 -> zlib 解壓 -> (可能再包一層 XML)。

注意:這裡的 DES **不是**標準 DES,不能拿 pycryptodome 之類的函式庫來解。
QQ 用的是一份流傳很廣、S-box 打錯字的 C 語言 DES 實作 (sbox2 第 24 個值應為 2 卻寫成 15、
sbox4 第 53 個值應為 13 卻寫成 10)。這些錯誤讓它變成一個「自成一格但仍可逆」的 Feistel
密碼,所以只能照著同一份錯的表實作。

出處 / Attribution
------------------
本檔的 DES 實作移植自 Lyricify 的 DESHelper.cs:
    https://github.com/WXRIW/Lyricify-App

    Copyright 2023 XY Wang, WXRIW

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

授權全文見 third_party/Lyricify-LICENSE-Apache-2.0.txt。

修改聲明 (Apache-2.0 §4(b)):本檔為修改後的版本 —— 由 C# 移植為 Python,
並加入 QRC 專用的 hex 解碼、zlib 解壓與 XML 外層處理。
"""
import binascii
import zlib

ENCRYPT = 1
DECRYPT = 0

_QQ_KEY = b"!@#)(*$%123ZXC!@!@#)(NHL"

# fmt: off
_SBOX = [
    [14,  4, 13,  1,  2, 15, 11,  8,  3, 10,  6, 12,  5,  9,  0,  7,
      0, 15,  7,  4, 14,  2, 13,  1, 10,  6, 12, 11,  9,  5,  3,  8,
      4,  1, 14,  8, 13,  6,  2, 11, 15, 12,  9,  7,  3, 10,  5,  0,
     15, 12,  8,  2,  4,  9,  1,  7,  5, 11,  3, 14, 10,  0,  6, 13],
    [15,  1,  8, 14,  6, 11,  3,  4,  9,  7,  2, 13, 12,  0,  5, 10,
      3, 13,  4,  7, 15,  2,  8, 15, 12,  0,  1, 10,  6,  9, 11,  5,   # 這個 15 是原始碼的錯值
      0, 14,  7, 11, 10,  4, 13,  1,  5,  8, 12,  6,  9,  3,  2, 15,
     13,  8, 10,  1,  3, 15,  4,  2, 11,  6,  7, 12,  0,  5, 14,  9],
    [10,  0,  9, 14,  6,  3, 15,  5,  1, 13, 12,  7, 11,  4,  2,  8,
     13,  7,  0,  9,  3,  4,  6, 10,  2,  8,  5, 14, 12, 11, 15,  1,
     13,  6,  4,  9,  8, 15,  3,  0, 11,  1,  2, 12,  5, 10, 14,  7,
      1, 10, 13,  0,  6,  9,  8,  7,  4, 15, 14,  3, 11,  5,  2, 12],
    [ 7, 13, 14,  3,  0,  6,  9, 10,  1,  2,  8,  5, 11, 12,  4, 15,
     13,  8, 11,  5,  6, 15,  0,  3,  4,  7,  2, 12,  1, 10, 14,  9,
     10,  6,  9,  0, 12, 11,  7, 13, 15,  1,  3, 14,  5,  2,  8,  4,
      3, 15,  0,  6, 10, 10, 13,  8,  9,  4,  5, 11, 12,  7,  2, 14],  # 第二個 10 是原始碼的錯值
    [ 2, 12,  4,  1,  7, 10, 11,  6,  8,  5,  3, 15, 13,  0, 14,  9,
     14, 11,  2, 12,  4,  7, 13,  1,  5,  0, 15, 10,  3,  9,  8,  6,
      4,  2,  1, 11, 10, 13,  7,  8, 15,  9, 12,  5,  6,  3,  0, 14,
     11,  8, 12,  7,  1, 14,  2, 13,  6, 15,  0,  9, 10,  4,  5,  3],
    [12,  1, 10, 15,  9,  2,  6,  8,  0, 13,  3,  4, 14,  7,  5, 11,
     10, 15,  4,  2,  7, 12,  9,  5,  6,  1, 13, 14,  0, 11,  3,  8,
      9, 14, 15,  5,  2,  8, 12,  3,  7,  0,  4, 10,  1, 13, 11,  6,
      4,  3,  2, 12,  9,  5, 15, 10, 11, 14,  1,  7,  6,  0,  8, 13],
    [ 4, 11,  2, 14, 15,  0,  8, 13,  3, 12,  9,  7,  5, 10,  6,  1,
     13,  0, 11,  7,  4,  9,  1, 10, 14,  3,  5, 12,  2, 15,  8,  6,
      1,  4, 11, 13, 12,  3,  7, 14, 10, 15,  6,  8,  0,  5,  9,  2,
      6, 11, 13,  8,  1,  4, 10,  7,  9,  5,  0, 15, 14,  2,  3, 12],
    [13,  2,  8,  4,  6, 15, 11,  1, 10,  9,  3, 14,  5,  0, 12,  7,
      1, 15, 13,  8, 10,  3,  7,  4, 12,  5,  6, 11,  0, 14,  9,  2,
      7, 11,  4,  1,  9, 12, 14,  2,  0,  6, 10, 13, 15,  3,  5,  8,
      2,  1, 14,  7,  4, 10,  8, 13, 15, 12,  9,  0,  3,  5,  6, 11],
]

_KEY_RND_SHIFT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
_KEY_PERM_C = [56, 48, 40, 32, 24, 16,  8,  0, 57, 49, 41, 33, 25, 17,
                9,  1, 58, 50, 42, 34, 26, 18, 10,  2, 59, 51, 43, 35]
_KEY_PERM_D = [62, 54, 46, 38, 30, 22, 14,  6, 61, 53, 45, 37, 29, 21,
               13,  5, 60, 52, 44, 36, 28, 20, 12,  4, 27, 19, 11,  3]
_KEY_COMPRESSION = [13, 16, 10, 23,  0,  4,  2, 27, 14,  5, 20,  9,
                    22, 18, 11,  3, 25,  7, 15,  6, 26, 19, 12,  1,
                    40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47,
                    43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31]

_IP_L = [57, 49, 41, 33, 25, 17,  9,  1, 59, 51, 43, 35, 27, 19, 11,  3,
         61, 53, 45, 37, 29, 21, 13,  5, 63, 55, 47, 39, 31, 23, 15,  7]
_IP_R = [56, 48, 40, 32, 24, 16,  8,  0, 58, 50, 42, 34, 26, 18, 10,  2,
         60, 52, 44, 36, 28, 20, 12,  4, 62, 54, 46, 38, 30, 22, 14,  6]

_P_PERM = [15,  6, 19, 20, 28, 11, 27, 16,  0, 14, 22, 25,  4, 17, 30,  9,
            1,  7, 23, 13, 31, 26,  2,  8, 18, 12, 29,  5, 21, 10,  3, 24]

# 逆初始置換的輸出位元組順序 (k=7 寫到 byte 3、k=0 寫到 byte 4)
_INV_IP_ORDER = [3, 2, 1, 0, 7, 6, 5, 4]
# fmt: on

_MASK32 = 0xFFFFFFFF


def _bitnum(data, b, c):
    return ((data[b // 32 * 4 + 3 - b % 32 // 8] >> (7 - (b % 8))) & 0x01) << c


def _bitnumintr(a, b, c):
    return ((a >> (31 - b)) & 0x01) << c


def _bitnumintl(a, b, c):
    return ((a << b) & 0x80000000) >> c


def _sboxbit(a):
    return (a & 0x20) | ((a & 0x1F) >> 1) | ((a & 0x01) << 4)


def _key_schedule(key, mode):
    """key: 8 bytes -> 16 組 6-byte 子金鑰"""
    schedule = [bytearray(6) for _ in range(16)]

    c = 0
    for i in range(28):
        c |= _bitnum(key, _KEY_PERM_C[i], 31 - i)
    d = 0
    for i in range(28):
        d |= _bitnum(key, _KEY_PERM_D[i], 31 - i)

    for i in range(16):
        s = _KEY_RND_SHIFT[i]
        c = ((c << s) | (c >> (28 - s))) & 0xFFFFFFF0
        d = ((d << s) | (d >> (28 - s))) & 0xFFFFFFF0

        to_gen = 15 - i if mode == DECRYPT else i
        sub = schedule[to_gen]
        for j in range(24):
            sub[j // 8] |= _bitnumintr(c, _KEY_COMPRESSION[j], 7 - (j % 8))
        for j in range(24, 48):
            sub[j // 8] |= _bitnumintr(d, _KEY_COMPRESSION[j] - 27, 7 - (j % 8))

    return schedule


def _f(state, key):
    # 擴張置換 E:32 bit -> 48 bit,拆成 t1/t2 兩個 24 bit
    t1 = (_bitnumintl(state, 31, 0) | ((state & 0xF0000000) >> 1) | _bitnumintl(state, 4, 5) |
          _bitnumintl(state, 3, 6) | ((state & 0x0F000000) >> 3) | _bitnumintl(state, 8, 11) |
          _bitnumintl(state, 7, 12) | ((state & 0x00F00000) >> 5) | _bitnumintl(state, 12, 17) |
          _bitnumintl(state, 11, 18) | ((state & 0x000F0000) >> 7) | _bitnumintl(state, 16, 23))
    t2 = (_bitnumintl(state, 15, 0) | ((state & 0x0000F000) << 15) | _bitnumintl(state, 20, 5) |
          _bitnumintl(state, 19, 6) | ((state & 0x00000F00) << 13) | _bitnumintl(state, 24, 11) |
          _bitnumintl(state, 23, 12) | ((state & 0x000000F0) << 11) | _bitnumintl(state, 28, 17) |
          _bitnumintl(state, 27, 18) | ((state & 0x0000000F) << 9) | _bitnumintl(state, 0, 23))

    lrg = [
        ((t1 >> 24) & 0xFF) ^ key[0],
        ((t1 >> 16) & 0xFF) ^ key[1],
        ((t1 >> 8) & 0xFF) ^ key[2],
        ((t2 >> 24) & 0xFF) ^ key[3],
        ((t2 >> 16) & 0xFF) ^ key[4],
        ((t2 >> 8) & 0xFF) ^ key[5],
    ]

    state = ((_SBOX[0][_sboxbit(lrg[0] >> 2)] << 28) |
             (_SBOX[1][_sboxbit(((lrg[0] & 0x03) << 4) | (lrg[1] >> 4))] << 24) |
             (_SBOX[2][_sboxbit(((lrg[1] & 0x0F) << 2) | (lrg[2] >> 6))] << 20) |
             (_SBOX[3][_sboxbit(lrg[2] & 0x3F)] << 16) |
             (_SBOX[4][_sboxbit(lrg[3] >> 2)] << 12) |
             (_SBOX[5][_sboxbit(((lrg[3] & 0x03) << 4) | (lrg[4] >> 4))] << 8) |
             (_SBOX[6][_sboxbit(((lrg[4] & 0x0F) << 2) | (lrg[5] >> 6))] << 4) |
             _SBOX[7][_sboxbit(lrg[5] & 0x3F)])

    out = 0
    for i, b in enumerate(_P_PERM):
        out |= _bitnumintl(state, b, i)
    return out & _MASK32


def _crypt(block, schedule):
    """單次 DES,block 為 8 bytes"""
    left = 0
    for i, b in enumerate(_IP_L):
        left |= _bitnum(block, b, 31 - i)
    right = 0
    for i, b in enumerate(_IP_R):
        right |= _bitnum(block, b, 31 - i)

    for i in range(15):
        left, right = right, _f(right, schedule[i]) ^ left
    left = _f(right, schedule[15]) ^ left

    # 逆初始置換。輸出位元組的順序在每個 4-byte 群組內是反的 (跟 _bitnum 的定址方式一致)
    out = bytearray(8)
    for k in range(8):
        byte = 0
        for j in range(8):
            src = right if j % 2 == 0 else left
            byte |= _bitnumintr(src, k + 8 * (j // 2), 7 - j)
        out[_INV_IP_ORDER[7 - k]] = byte
    return bytes(out)


def _triple_des_schedules(key, mode):
    if mode == ENCRYPT:
        return [_key_schedule(key[0:8], ENCRYPT),
                _key_schedule(key[8:16], DECRYPT),
                _key_schedule(key[16:24], ENCRYPT)]
    return [_key_schedule(key[16:24], DECRYPT),
            _key_schedule(key[8:16], ENCRYPT),
            _key_schedule(key[0:8], DECRYPT)]


def _triple_des(block, schedules):
    for sched in schedules:
        block = _crypt(block, sched)
    return block


def decrypt_qrc(hex_text: str) -> str:
    """QRC hex 字串 -> 明文 (可能是 QRC 文字,也可能是包著 QRC 的 XML)"""
    data = binascii.unhexlify(hex_text.strip())
    schedules = _triple_des_schedules(_QQ_KEY, DECRYPT)
    out = b''.join(_triple_des(data[i:i + 8], schedules) for i in range(0, len(data), 8))
    text = zlib.decompress(out)
    if text.startswith(b'\xef\xbb\xbf'):
        text = text[3:]
    return text.decode('utf-8', 'ignore')


def _selftest():
    enc = _triple_des_schedules(_QQ_KEY, ENCRYPT)
    dec = _triple_des_schedules(_QQ_KEY, DECRYPT)
    for plain in (b'12345678', b'\x00' * 8, b'\xff' * 8, bytes(range(8))):
        assert _triple_des(_triple_des(plain, enc), dec) == plain, plain.hex()

    # 走完整條 decrypt_qrc:自己壓縮 + 加密一段 QRC,再解回來
    sample = '[0,1000]私(0,500)は(500,500)'.encode('utf-8')
    blob = zlib.compress(sample)
    blob += b'\x00' * (-len(blob) % 8)  # 補到 8 的倍數
    cipher = b''.join(_triple_des(blob[i:i + 8], enc) for i in range(0, len(blob), 8))
    assert decrypt_qrc(cipher.hex()) == sample.decode('utf-8')
    print("qrc_decrypt selftest ok")


if __name__ == "__main__":
    import sys
    if sys.argv[1:2] == ["selftest"]:
        _selftest()
    else:
        print(decrypt_qrc(sys.argv[1]))
