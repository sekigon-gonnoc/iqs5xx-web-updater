import { WebSerial } from "./webSerial";
import { slip } from "slip";
import * as ihex from "intel-hex";

const READ_CMD = 0x01;
const CRC_CMD = 0x03;
const WRITE_CMD = 0x04;
const BLOCK_SIZE = 64;

type IQS5XX = {
  APP_START_ADDR: number;
  APP_END_ADDR: number;
  CRC_START_ADDR: number;
  CRC_END_ADDR: number;
  NVM_START_ADDR: number;
  NVM_END_ADDR: number;
};

const IQS572: IQS5XX = {
  APP_START_ADDR: 0x8400,
  APP_END_ADDR: 0xbfff,
  CRC_START_ADDR: 0x83c0,
  CRC_END_ADDR: 0x83ff,
  NVM_START_ADDR: 0xbe00,
  NVM_END_ADDR: 0xbfff,
};

type OpType = "write" | "verify";
class Iqs5xxMegaWriter {
  private comReceive: number[] = [];
  private serial: WebSerial;

  private dumpHex(arr: number[]): string {
    return arr
      .map((v) => {
        return v.toString(16);
      })
      .join(" ");
  }

  private sleep(ms: number) {
    return new Promise((resolve: any) => setTimeout(resolve, ms));
  }

  private splitToChunk(arr: Uint8Array, size: number): number[][] {
    let ret = [];
    let i: number;
    let j: number;
    for (i = 0, j = arr.length; i < j; i += size) {
      ret.push(arr.slice(i, i + size));
    }

    return ret;
  }

  private receiveResponse(arr: Uint8Array) {
    this.comReceive = this.comReceive.concat(Array.from(arr));
  }

  private async readResponse(size: number, timeout: number): Promise<number[]> {
    let cnt = 0;
    while (this.comReceive.length < size && cnt < timeout) {
      await this.sleep(1);
      cnt += 1;
    }

    if (cnt >= timeout) {
      return [];
    }

    let ret = this.comReceive.slice(0, size);
    this.comReceive = this.comReceive.slice(size);

    return ret;
  }

  private async initBootloader() {
    this.serial = new WebSerial(128, 5);
    this.serial.setReceiveCallback(this.receiveResponse.bind(this));
    await this.serial.open(null, 57600);
    this.serial.startReadLoop();
  }

  private async writeBlock(addr: number, block: number[]) {
    if (block.length > BLOCK_SIZE) {
      return Promise.reject(new Error("Invalid block size"));
    }

    let cmd: number[] = [
      WRITE_CMD,
      4 + BLOCK_SIZE,
      addr >> 8,
      addr & 0xff,
    ].concat(Array.from(block));
    let packet = Uint8Array.from(slip.encode(cmd).slice(1));
    // console.log(packet);

    await this.serial.write(packet);
    let ret = await this.readResponse(1, 1000);

    if (ret[0] != 0) {
      return Promise.reject("Failed to write block.");
    }
  }

  private async readBlock(addr: number): Promise<number[]> {
    let cmd: number[] = [READ_CMD, 4, addr >> 8, addr & 0xff];
    let packet = Uint8Array.from(slip.encode(cmd).slice(1));

    await this.serial.write(packet);
    let ret = await this.readResponse(BLOCK_SIZE + 1, 1000);

    if (ret[0] != 0) {
      return Promise.reject("Failed to read block.");
    }

    return ret.slice(1);
  }

  private async writeFlash(
    start: number,
    bin: number[],
    progress: (msg: string) => void = () => {}
  ) {
    let addr = start;

    let chunks = this.splitToChunk(Uint8Array.from(bin), BLOCK_SIZE);

    for (let chunk of chunks) {
      await this.writeBlock(addr, chunk);

      addr += BLOCK_SIZE;
      progress(".");
    }
  }

  private async checkCRC(crc: number[]) {
    if (crc.length != BLOCK_SIZE) {
      return Promise.reject(new Error("Invalid size CRC"));
    }

    await this.writeBlock(IQS572.CRC_START_ADDR, crc);
    console.log("Write crc bytes");

    let cmd: number[] = [CRC_CMD, 2];
    let packet = Uint8Array.from(slip.encode(cmd).slice(1));

    console.log("Send crc check command");
    await this.serial.write(packet);
    let ret = await this.readResponse(1, 1000);

    if (ret[0] != 0) {
      return Promise.reject(`Failed to CRC check.${ret[0]}`);
    }
  }

  private async readFlash(
    start: number,
    end: number,
    progress: (msg: string) => void = () => {}
  ): Promise<number[]> {
    let addr = start;
    let res = [];

    while (addr < end) {
      let block = await this.readBlock(addr);
      res = res.concat(block);
      addr += BLOCK_SIZE;
      progress(".");
    }

    console.log(
      `Received flash data from 0x${start.toString(16)} to 0x${end.toString(
        16
      )}`,
      res
    );
    return res;
  }

  private async verifyFlash(
    start: number,
    end: number,
    bin: number[],
    progress: (msg: string) => void = () => {}
  ) {
    let rcv = await this.readFlash(start, end, progress);
    for (let idx = 0; idx < bin.length; idx++) {
      if (bin[idx] != rcv[idx]) {
        return Promise.reject(
          new Error(`Verify failed at address 0x${(start + idx).toString(16)}`)
        );
      }
    }
  }

  private loadHex(
    hex: string
  ): { app: number[]; crc: number[]; nvm: number[] } {
    let parsed_hex = ihex.parse(hex);
    console.log(parsed_hex);
    let app = parsed_hex.data.slice(
      IQS572.APP_START_ADDR,
      IQS572.APP_END_ADDR + 1
    );
    let crc = parsed_hex.data.slice(
      IQS572.CRC_START_ADDR,
      IQS572.CRC_END_ADDR + 1
    );
    let nvm = parsed_hex.data.slice(
      IQS572.NVM_START_ADDR,
      IQS572.NVM_END_ADDR + 1
    );
    return { app, crc, nvm };
  }

  async verify(hex: string, progress: (msg: string) => void = () => {}) {
    let { app, crc, nvm } = this.loadHex(hex);
    console.log("Firm loaded", app, crc, nvm);

    await this.initBootloader();

    try {
      progress(`Verify ${app.length} bytes.\n`);
      await this.verifyFlash(
        IQS572.APP_START_ADDR,
        IQS572.APP_END_ADDR,
        app,
        progress
      );
      progress("Verify complete\n");
    } catch (e) {
      progress("\n" + e.toString() + "\n");
      progress("Verify failed\n");
    } finally {
      this.serial.close();
    }
  }

  async write(hex: string, progress: (msg: string) => void = () => {}) {
    let { app, crc, nvm } = this.loadHex(hex);
    console.log("Firm loaded", app, crc, nvm);

    await this.initBootloader();

    try {
      progress(`Flash ${app.length} bytes...`);
      // nvm region is included in app
      await this.writeFlash(IQS572.APP_START_ADDR, app, progress);
      progress("Flash complete.\n");

      progress("Verify start...");
      await this.checkCRC(crc);

      // NVM region is not included in CRC calculation, so verify byte by byte
      await this.verifyFlash(
        IQS572.NVM_START_ADDR,
        IQS572.NVM_END_ADDR,
        nvm,
        progress
      );
      progress("Verify complte.\n");
    } catch (e) {
      progress("\n" + e.toString() + "\n");
      progress("Flash failed\n");
    } finally {
      this.serial.close();
    }
  }
}

export { Iqs5xxMegaWriter };
