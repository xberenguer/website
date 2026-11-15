import { ESPLoader, Transport } from './vendor/esptool-js-0.7.1.js';
import { requireThat, validateIdentity } from './core.js';

export class DeviceConnection {
  async connect(port, device) {
    this.transport = new Transport(port,false);
    this.loader = new ESPLoader({ transport:this.transport, baudrate:115200, romBaudrate:115200,
      terminal:{ clean(){}, write(){}, writeLine(){} } });
    await this.loader.detectChip('default_reset');
    requireThat(this.loader.chip.CHIP_NAME === 'ESP32-S3' && this.loader.chip.IMAGE_CHIP_ID === 9, 'Wrong chip: choose an ESP32-S3 device.');
    const security = await this.loader.getSecurityInfo();
    requireThat(!this.loader.secureDownloadMode && security.flashCryptCnt === 0 && !(security.flags & 5), 'Encrypted or secure-boot devices need their own signed installation process.');
    await this.loader.chip.postConnect?.(this.loader);
    await this.loader.runStub();
    requireThat(this.loader.IS_STUB === true, 'Could not start the flash verification stub.');
    await this.loader.flashSpiAttach(0);
    this.loader.FLASH_READ_TIMEOUT=20000;
    const identity = await this.identify(); validateIdentity(identity,device);
    return identity;
  }
  async identify() {
    const chip = this.loader.chip;
    const flashId = await this.loader.readFlashId();
    const code = (flashId >>> 16) & 255;
    requireThat(flashId !== 0 && flashId !== 0xffffff && (code === 0x17 || code === 0x19), 'Unsupported or unreadable flash chip.');
    return { chip:chip.CHIP_NAME, imageChipId:chip.IMAGE_CHIP_ID, capacity:2 ** code, mac:(await chip.readMac(this.loader)).toLowerCase() };
  }
  async close(reset = false) {
    let resetSent = false;
    try { if (reset && this.loader) { await this.loader.after('hard_reset'); resetSent = true; } }
    finally {
      try { await this.transport?.disconnect(); } catch (error) { if (!resetSent) throw error; }
      this.loader = null;
    }
  }
}
