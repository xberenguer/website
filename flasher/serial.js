import { observe } from './events.js';
import { configureFlash } from './flash-read.js';
import { ESPLoader } from './vendor/esptool-js-0.7.1.js';
import { QueuedTransport } from './serial-transport.js';
import { requireThat, validateIdentity } from './core.js';

export class DeviceConnection {
  constructor(onEvent=()=>{}) { this.onEvent=onEvent; }
  report(event) { observe(this.onEvent,event); }
  async connect(port, device) {
    this.report({type:'progress',phase:'connect',label:'Connecting to the ESP32-S3'});
    this.report({type:'log',message:'Opening Web Serial · 115200 baud'});
    this.transport = new QueuedTransport(port);
    this.loader = new ESPLoader({ transport:this.transport, baudrate:115200, romBaudrate:115200, serialOptions:{bufferSize:65536},
      terminal:{ clean(){}, write:data=>this.report({type:'terminal',text:data}), writeLine:data=>this.report({type:'terminal',text:data,newline:true}) } });
    await this.loader.detectChip('default_reset');
    requireThat(this.loader.chip.CHIP_NAME === 'ESP32-S3' && this.loader.chip.IMAGE_CHIP_ID === 9, 'Wrong chip: choose an ESP32-S3 device.');
    this.report({type:'log',message:'ESP32-S3 detected. Checking security configuration.'});
    const security = await this.loader.getSecurityInfo();
    requireThat(!this.loader.secureDownloadMode && security.flashCryptCnt === 0 && !(security.flags & 5), 'Encrypted or secure-boot devices need their own signed installation process.');
    await this.loader.chip.postConnect?.(this.loader);
    this.report({type:'log',message:'Security configuration accepted. Starting verification stub in RAM.'});
    await this.loader.runStub();
    requireThat(this.loader.IS_STUB === true, 'Could not start the flash verification stub.');
    await this.loader.flashSpiAttach(0);
    this.loader.FLASH_READ_TIMEOUT=20000;
    const identity = await this.identify(); validateIdentity(identity,device);
    await configureFlash(this.loader,identity.capacity);
    await this.loader.flashMd5sum(0x8000,4096);
    this.report({type:'log',level:'success',message:`Device checked · ${identity.chip} · ${identity.capacity/1048576} MiB flash. Verification stub ready.`});
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
    this.report({type:'log',message:reset?'Restarting device and closing USB.':'Closing USB connection.'});
    let resetSent = false;
    try { if (reset && this.loader) { await this.loader.after('hard_reset'); resetSent = true; } }
    finally {
      try { await this.transport?.disconnect(); } catch (error) { if (!resetSent) throw error; }
      this.loader = null;
    }
  }
}
