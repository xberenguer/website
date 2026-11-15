// Read-only ESP stub protocol adapter for esptool-js 0.7.1.
// It owns the trailing digest: callers must NOT read that frame again.
const wordsLE = (...words) => {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setUint32(i * 4, word, true));
  return bytes;
};
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function configureFlash(loader, flashBytes) {
  if (!loader.IS_STUB || !Number.isSafeInteger(flashBytes) || flashBytes <= 0 || flashBytes >= 2 ** 32) {
    throw new Error('Unsupported flash configuration');
  }
  // SPI_SET_PARAMS changes RAM flash-chip configuration, not flash contents.
  await loader.checkCommand('configure flash', 0x0b,
    wordsLE(0, flashBytes, 65536, 4096, 256, 0xffff));
}

export async function readFlashFramed(loader, address, length, {
  md5Hex, packetSize = 1024, maxInflight = 64,
  timeout = loader.FLASH_READ_TIMEOUT, onStage = () => {},
} = {}) {
  if (!loader.IS_STUB || typeof md5Hex !== 'function' ||
      !Number.isSafeInteger(address) || address < 0 ||
      !Number.isSafeInteger(length) || length < 1 || address + length > 2 ** 32 ||
      !Number.isInteger(packetSize) || packetSize < 1 || packetSize > 4096 ||
      !Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 64) {
    throw new Error('Invalid verified flash read');
  }
  let stage = 'command';
  let received = 0;
  const result = new Uint8Array(length);
  const notify = () => onStage({ stage, received, total: length });
  try {
    notify();
    const status = await loader.checkCommand('read flash', loader.ESP_READ_FLASH,
      wordsLE(address, length, packetSize, maxInflight));
    if (status !== 0) throw new Error('Unexpected read command value');
    stage = 'accepted'; notify();
    while (received < length) {
      stage = 'data'; notify();
      const packet = await loader.transport.read(timeout);
      const expected = Math.min(packetSize, length - received);
      if (!(packet instanceof Uint8Array) || packet.length !== expected) {
        throw new Error(`Expected ${expected} data bytes; received ${packet?.length ?? 'none'}`);
      }
      result.set(packet, received); received += packet.length;
      stage = 'ack'; notify();
      await loader.transport.write(wordsLE(received));
    }
    stage = 'digest'; notify();
    const digest = await loader.transport.read(timeout);
    if (!(digest instanceof Uint8Array) || digest.length !== 16 || hex(digest) !== md5Hex(result).toLowerCase()) {
      throw new Error('Read digest mismatch');
    }
    stage = 'verified'; notify();
    return result;
  } catch (cause) {
    throw new Error(`Flash read ${stage} failed (${received}/${length} bytes): ${cause.message}`, { cause });
  }
}
