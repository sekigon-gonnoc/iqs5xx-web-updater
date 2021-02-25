import { Iqs5xxMegaWriter } from "./iqs5xx.ts";

const iqs5xx = new Iqs5xxMegaWriter();

let progress = document.getElementById("progress");

if (!navigator.serial) {
  progress.innerHTML =
    "Web serial is unavailable.\nPlease use Google Chrome and and set the #enable-experimental-web-platform-features flag in chrome://flags.\n";
  console.error("Web serial is unavailable");
}

async function verifyFirmware() {
  let hex = await fetch("./iqs_settings_bl.hex").then((r) => {
    return r.text();
  });

  progress.innerHTML =
    "Connect pro micro with bootloader keymap, and select serial port appreared.\n";

  await iqs5xx.verify(hex, (str) => {
    progress.innerHTML += str;
    console.log(str);
  });
}

async function flashFirmware() {
  let hex = await fetch("./iqs_settings_bl.hex").then((r) => {
    return r.text();
  });

  progress.innerHTML =
    "Connect pro micro with bootloader keymap, and select serial port appreared.\n";

  await iqs5xx.write(hex, (str) => {
    progress.innerHTML += str;
    console.log(str);
  });
}

document.getElementById("verify").onclick = verifyFirmware;
document.getElementById("flash").onclick = flashFirmware;
document.getElementById(
  "revision"
).innerText = `Revision:${process.env.REVISION}`;
