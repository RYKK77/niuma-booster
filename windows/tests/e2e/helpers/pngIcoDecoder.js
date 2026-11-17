'use strict';

const zlib = require('node:zlib');

/**
 * 纯 Node.js（零外部依赖）ICO 与 PNG 二进制解码工具
 * 支持解析 ICONDIR/ICONDIRENTRY、提取内嵌 PNG 帧、校验 IHDR 并完整执行 PNG Filter 0-4 反滤波输出 RGBA 像素。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 解析 .ico 二进制文件
 * @param {Buffer} buf
 */
function parseIco(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('parseIco 需要 Buffer 输入');
  }
  if (buf.length < 6) {
    throw new Error(`ICO 文件过小: ${buf.length} 字节`);
  }
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) {
    throw new Error(`无效 ICO 文件头: reserved=${reserved}, type=${type}`);
  }
  const dirEnd = 6 + count * 16;
  if (buf.length < dirEnd) {
    throw new Error(`ICO 目录表越界: 需要 ${dirEnd} 字节，实际 ${buf.length} 字节`);
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const rawW = buf[off];
    const rawH = buf[off + 1];
    const width = rawW === 0 ? 256 : rawW;
    const height = rawH === 0 ? 256 : rawH;
    const colorCount = buf[off + 2];
    const planes = buf.readUInt16LE(off + 4);
    const bitCount = buf.readUInt16LE(off + 6);
    const bytesInRes = buf.readUInt32LE(off + 8);
    const imageOffset = buf.readUInt32LE(off + 12);

    if (bytesInRes === 0 || imageOffset + bytesInRes > buf.length) {
      throw new Error(`ICO 帧[${i}]偏移越界: offset=${imageOffset}, size=${bytesInRes}, total=${buf.length}`);
    }
    const data = buf.subarray(imageOffset, imageOffset + bytesInRes);
    const isPng = data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE);

    entries.push({
      index: i,
      width,
      height,
      colorCount,
      planes,
      bitCount,
      bytesInRes,
      imageOffset,
      isPng,
      data,
    });
  }

  return {
    reserved,
    type,
    count,
    entries,
    getFrame(w, h) {
      return entries.find((e) => e.width === w && e.height === h) || null;
    },
  };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG 图像为 RGBA 像素数据（支持 Filter 0-4、colorType 6 RGBA 及 colorType 2 RGB）
 * @param {Buffer} buf
 */
function decodePngRgba(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('decodePngRgba 需要 Buffer 输入');
  }
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('无效 PNG 魔数');
  }

  let offset = 8;
  let ihdr = null;
  const idatChunks = [];
  let seenIend = false;

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`PNG chunk ${type} 越界`);
    }
    const chunkData = buf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      if (length !== 13) throw new Error(`IHDR 长度异常: ${length}`);
      ihdr = {
        width: chunkData.readUInt32BE(0),
        height: chunkData.readUInt32BE(4),
        bitDepth: chunkData[8],
        colorType: chunkData[9],
        compression: chunkData[10],
        filter: chunkData[11],
        interlace: chunkData[12],
      };
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      seenIend = true;
      break;
    }

    offset = dataEnd + 4;
  }

  if (!ihdr) throw new Error('PNG 缺少 IHDR chunk');
  if (!seenIend) throw new Error('PNG 缺少 IEND chunk');
  if (ihdr.bitDepth !== 8) {
    throw new Error(`仅支持 8-bit PNG，当前 bitDepth=${ihdr.bitDepth}`);
  }
  if (ihdr.interlace !== 0) {
    throw new Error(`不支持交错 PNG (interlace=${ihdr.interlace})`);
  }
  if (ihdr.colorType !== 6 && ihdr.colorType !== 2) {
    throw new Error(`不支持的 PNG colorType=${ihdr.colorType}（期望 6 RGBA 或 2 RGB）`);
  }

  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const stride = ihdr.width * bpp;
  const compressed = Buffer.concat(idatChunks);
  const inflated = zlib.inflateSync(compressed);

  const expectedLen = ihdr.height * (1 + stride);
  if (inflated.length < expectedLen) {
    throw new Error(`PNG 解压数据不足: 期望 ${expectedLen}，实际 ${inflated.length}`);
  }

  const rawPixels = new Uint8Array(ihdr.height * stride);
  for (let y = 0; y < ihdr.height; y++) {
    const inRow = y * (1 + stride);
    const outRow = y * stride;
    const filterType = inflated[inRow];

    for (let x = 0; x < stride; x++) {
      const filt = inflated[inRow + 1 + x];
      const a = x >= bpp ? rawPixels[outRow + x - bpp] : 0;
      const b = y > 0 ? rawPixels[outRow - stride + x] : 0;
      const c = y > 0 && x >= bpp ? rawPixels[outRow - stride + x - bpp] : 0;

      let recon;
      switch (filterType) {
        case 0:
          recon = filt;
          break;
        case 1:
          recon = (filt + a) & 0xff;
          break;
        case 2:
          recon = (filt + b) & 0xff;
          break;
        case 3:
          recon = (filt + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          recon = (filt + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`未知 PNG 行滤波器类型: ${filterType}`);
      }
      rawPixels[outRow + x] = recon;
    }
  }

  let data;
  if (bpp === 4) {
    data = rawPixels;
  } else {
    data = new Uint8Array(ihdr.width * ihdr.height * 4);
    for (let i = 0, j = 0; i < rawPixels.length; i += 3, j += 4) {
      data[j] = rawPixels[i];
      data[j + 1] = rawPixels[i + 1];
      data[j + 2] = rawPixels[i + 2];
      data[j + 3] = 255;
    }
  }

  function getPixel(x, y) {
    if (x < 0 || x >= ihdr.width || y < 0 || y >= ihdr.height) {
      throw new RangeError(`像素坐标越界: (${x}, ${y})，图像尺寸 ${ihdr.width}x${ihdr.height}`);
    }
    const idx = (y * ihdr.width + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
  }

  return {
    width: ihdr.width,
    height: ihdr.height,
    colorType: ihdr.colorType,
    bitDepth: ihdr.bitDepth,
    data,
    getPixel,
  };
}

module.exports = {
  PNG_SIGNATURE,
  parseIco,
  decodePngRgba,
};
