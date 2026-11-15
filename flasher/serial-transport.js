// Persistent Web Serial reader for the pinned Espressif loader.
// SLIP framing follows RFC 1055. No received bytes are logged or uploaded.
import { Transport } from './vendor/esptool-js-0.7.1.js';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
export class QueuedTransport extends Transport {
  constructor(port) {
    super(port,false);
    this.packets=[];this.queuedBytes=0;this.frame=new Uint8Array(1024);this.frameLength=0;
    this.inFrame=false;this.escaping=false;this.pending=null;this.pump=null;
    this.failure=null;this.closing=false;this.rawBytes=0;this.frames=0;this.writes=0;
    this.lastRx=0;this.tail=new Uint8Array(0);
  }
  async connect(baud,options={}) {
    this.closing=false;this.failure=null;this.flushInput();
    await super.connect(baud,options);
  }
  diagnostics() {
    return {rawBytes:this.rawBytes,frames:this.frames,partialBytes:this.frameLength,
      queuedFrames:this.packets.length,writes:this.writes,lastRxAge:this.lastRx?Date.now()-this.lastRx:null,
      streamError:this.failure?.name||null};
  }
  invalidate(error) {this.fail(error instanceof Error?error:new Error(String(error)));}
  fail(error) {
    if(!this.failure)this.failure=error;
    if(this.pending){const pending=this.pending;this.pending=null;clearTimeout(pending.timer);pending.reject(this.failure);}
  }
  deliver(packet) {
    ++this.frames;
    if(this.pending){const pending=this.pending;this.pending=null;clearTimeout(pending.timer);pending.resolve(packet);}
    else {
      if(this.queuedBytes+packet.length>1024*1024||this.packets.length>=1024)throw Error('USB receive queue overflow');
      this.packets.push(packet);this.queuedBytes+=packet.length;
    }
  }
  feed(bytes) {
    this.rawBytes+=bytes.length;this.lastRx=Date.now();
    const recent=new Uint8Array(Math.min(4096,this.tail.length+bytes.length));
    if(bytes.length>=4096)recent.set(bytes.subarray(bytes.length-4096));
    else{const keep=recent.length-bytes.length;recent.set(this.tail.subarray(this.tail.length-keep));recent.set(bytes,keep);}
    this.tail=recent;
    for(const byte of bytes){
      if(!this.inFrame){if(byte===0xc0){this.inFrame=true;this.frameLength=0;this.escaping=false;}continue;}
      let decoded=byte;
      if(this.escaping){this.escaping=false;if(byte===0xdc)decoded=0xc0;else if(byte===0xdd)decoded=0xdb;else throw Error('Invalid USB SLIP escape');}
      else if(byte===0xdb){this.escaping=true;continue;}
      else if(byte===0xc0){if(this.frameLength)this.deliver(this.frame.slice(0,this.frameLength));this.frameLength=0;continue;}
      if(this.frameLength===this.frame.length){if(this.frame.length>=65536)throw Error('USB receive frame too large');const bigger=new Uint8Array(this.frame.length*2);bigger.set(this.frame);this.frame=bigger;}
      this.frame[this.frameLength++]=decoded;
    }
  }
  readLoop() {
    if(this.pump)return this.pump;
    this.pump=this.receive().finally(()=>{this.pump=null;});
    return this.pump;
  }
  async receive() {
    while(!this.closing&&this.device.readable){
      let reader;
      try{
        reader=this.device.readable.getReader();this.reader=reader;
        while(!this.closing){
          const {value,done}=await reader.read();
          if(done){if(!this.closing)this.fail(Error('USB receive stream ended'));return;}
          if(value?.length)this.feed(value);
        }
      }catch(error){if(!this.closing)this.fail(Error('USB receive failed ('+(error.name||'Error')+')'));return;}
      finally{reader?.releaseLock();if(this.reader===reader)this.reader=undefined;}
    }
  }
  read(timeout=3000) {
    if(this.failure)return Promise.reject(this.failure);
    if(this.pending)return Promise.reject(Error('Concurrent USB reads are not supported'));
    if(this.packets.length){const packet=this.packets.shift();this.queuedBytes-=packet.length;return Promise.resolve(packet);}
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending=null;reject(Error(`USB read timed out (partial=${this.frameLength}, raw=${this.rawBytes}, frames=${this.frames}, writes=${this.writes})`));},timeout);
      this.pending={resolve,reject,timer};
    });
  }
  flushInput() {
    if(this.pending)throw Error('Cannot discard input during an active USB read');
    this.packets=[];this.queuedBytes=0;this.frameLength=0;this.inFrame=false;this.escaping=false;
    this.tail=new Uint8Array(0);this.buffer=new Uint8Array(0);
  }
  peek(){return this.tail;}
  inWaiting(){return this.queuedBytes+this.frameLength;}
  async drainInput(quietMs=100,maxMs=400) {
    const until=Date.now()+maxMs;
    while(Date.now()<until&&Date.now()-this.lastRx<quietMs)await pause(Math.min(quietMs,20));
    this.flushInput();
  }
  async write(data) {
    if(this.failure)throw this.failure;
    if(!this.device.writable)throw Error('USB writable stream is unavailable');
    const writer=this.device.writable.getWriter();
    try{await writer.write(this.slipWriter(data));++this.writes;}
    catch(error){this.fail(Error('USB write failed ('+(error.name||'Error')+')'));throw this.failure;}
    finally{writer.releaseLock();}
  }
  async disconnect() {
    this.closing=true;
    if(this.pending){const pending=this.pending;this.pending=null;clearTimeout(pending.timer);pending.reject(Error('USB disconnected'));}
    try{await super.disconnect();}
    finally{this.flushInput();}
  }
}
