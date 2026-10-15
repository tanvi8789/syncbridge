/*
 * End-to-end check of PIN pairing and sensitive-file transfer: two
 * ConnectionManagers talk over loopback. Run with:
 *   npx tsx src/pairing/test-pairing.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { ConnectionManager } from "../connection/connection-manager";
import { TrustStore } from "./trust-store";
import type { PairingEvent } from "./pairing-messages";
import {
    WrongPinError,
    decryptFileWithPin,
    encryptFileWithPin,
} from "../transfer/sensitive-crypto";

const PORT = 41298;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-pairing-test-"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(label: string, check: () => boolean, ms = 5000) {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error(`Timed out: ${label}`);
        await sleep(25);
    }
}

function makeNode(id: string, name: string) {
    const events: PairingEvent[] = [];
    const trust = new TrustStore(path.join(tmp, `${id}-trust.json`));
    const manager = new ConnectionManager(
        id, name, PORT, 3000,
        undefined, undefined, undefined, undefined,
        trust, (e) => events.push(e)
    );
    return { id, name, manager, trust, events };
}

async function main() {
    const sender = makeNode("sender-dev", "Sender");
    const receiver = makeNode("receiver-dev", "Receiver");

    const server = net.createServer((s) => receiver.manager.handleIncomingConnection(s));
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

    const device = { deviceId: receiver.id, deviceName: "Receiver", ip: "127.0.0.1", platform: "test", lastSeen: Date.now() };
    const state = () => sender.manager.getConnections().find((c) => c.deviceId === receiver.id)?.state;

    // --- 1. Unknown device must pair with a PIN -----------------------
    await sender.manager.connectToDevice(device);
    await until("PIN displayed", () => receiver.events.some((e) => e.type === "PIN_DISPLAY"));
    await until("PIN requested", () => state() === "AWAITING_PIN");

    const pin = receiver.events.find((e) => e.type === "PIN_DISPLAY")!.pin!;
    assert.match(pin, /^\d{6}$/);
    assert.equal(receiver.manager.getPairingPrompts()[0].pin, pin);
    assert.equal(sender.manager.getPairingPrompts()[0].kind, "entry");

    // Nothing but the handshake works before authentication.
    assert.equal(receiver.manager.getConnectedDevices().length, 0);

    // --- 2. Wrong PIN is refused, then the right one works ------------
    const wrong = pin === "000000" ? "111111" : "000000";
    sender.manager.submitPairingPin(receiver.id, wrong);
    await until("retry", () => state() === "AWAITING_PIN" && sender.events.some((e) => e.error === "Incorrect PIN"));
    assert.equal(sender.trust.isTrusted(receiver.id), false);

    sender.manager.submitPairingPin(receiver.id, pin);
    await until("connected", () => state() === "CONNECTED");
    assert.equal(sender.trust.isTrusted(receiver.id), true);
    assert.equal(receiver.trust.isTrusted(sender.id), true);
    assert.equal(sender.trust.getSecret(receiver.id), receiver.trust.getSecret(sender.id), "both sides derive the same secret");
    console.log("ok  PIN pairing (with one wrong attempt)");

    // --- 3. Sensitive file: encrypted on the wire, locked at rest -----
    const original = path.join(tmp, "secret-plan.txt");
    const contents = "top secret ".repeat(20000);
    fs.writeFileSync(original, contents);

    const transferId = sender.manager.requestTransfer(receiver.id, original, { pin: "hunter22" })!;
    assert.ok(transferId);
    const received = () => receiver.manager.getTransfers().find((t) => t.transferId === transferId);
    await until("received", () => received()?.state === "COMPLETED");

    const locked = received()!;
    const encryptedPath = locked.savedPath!;
    const lockedName = locked.fileName;
    assert.equal(locked.locked, true);
    assert.ok(encryptedPath.endsWith(".sbenc"));
    assert.ok(!lockedName.includes("secret-plan"), "real name is hidden");
    assert.ok(!fs.readFileSync(encryptedPath).includes("top secret"), "ciphertext only");

    assert.throws(() => receiver.manager.unlockTransfer(transferId, "wrong-pin"), WrongPinError);
    assert.equal(received()!.locked, true);

    const unlocked = receiver.manager.unlockTransfer(transferId, "hunter22");
    assert.equal(unlocked.locked, false);
    assert.equal(path.basename(unlocked.savedPath!), "secret-plan.txt");
    assert.equal(fs.readFileSync(unlocked.savedPath!, "utf8"), contents);
    assert.ok(!fs.existsSync(encryptedPath), "encrypted copy removed after unlock");
    fs.rmSync(unlocked.savedPath!);
    console.log("ok  sensitive transfer: encrypted, locked, unlocked with PIN");

    // --- 4. Trusted device reconnects without a PIN -------------------
    sender.manager.disconnectDevice(receiver.id);
    await until("closed", () => receiver.manager.getConnectedDevices().length === 0);
    const promptsBefore = receiver.events.filter((e) => e.type === "PIN_DISPLAY").length;
    await sender.manager.connectToDevice(device);
    await until("reconnected", () => state() === "CONNECTED");
    assert.equal(receiver.events.filter((e) => e.type === "PIN_DISPLAY").length, promptsBefore, "no PIN for a trusted device");
    console.log("ok  trusted device reconnects without a PIN");

    // --- 5. Forgetting a device forces a new PIN ----------------------
    sender.manager.disconnectDevice(receiver.id);
    await until("closed", () => receiver.manager.getConnectedDevices().length === 0);
    receiver.manager.removeTrustedDevice(sender.id);
    await sender.manager.connectToDevice(device);
    await until("pin again", () => receiver.events.filter((e) => e.type === "PIN_DISPLAY").length > promptsBefore);
    // ...and a stale trust record on the sender side is rejected cleanly.
    await until("rejected", () => state() === "AWAITING_PIN");
    sender.manager.cancelPairing(receiver.id);
    await until("cancelled", () => state() === undefined);
    console.log("ok  forgotten device must re-pair");

    // --- 6. Too many wrong PINs aborts pairing ------------------------
    await sleep(100);
    await sender.manager.connectToDevice(device);
    await until("pin", () => state() === "AWAITING_PIN");
    const realPin = receiver.manager.getPairingPrompts()[0].pin!;
    const bad = realPin === "123456" ? "654321" : "123456";
    for (let i = 0; i < 3; i++) {
        await until("ready", () => state() === "AWAITING_PIN");
        sender.manager.submitPairingPin(receiver.id, bad);
        await sleep(150);
    }
    await until("aborted", () => state() === undefined);
    assert.equal(receiver.trust.isTrusted(sender.id), false);
    console.log("ok  3 wrong PINs abort pairing");

    // --- 7. Crypto round trip and tamper detection --------------------
    const enc = path.join(tmp, "x.sbenc");
    encryptFileWithPin(original, enc, "correct horse");
    const bytes = fs.readFileSync(enc);
    bytes[bytes.length - 20] ^= 0xff;
    fs.writeFileSync(enc, bytes);
    assert.throws(() => decryptFileWithPin(enc, path.join(tmp, "out"), "correct horse"), WrongPinError);
    assert.deepEqual(fs.existsSync(path.join(tmp, "out")) ? fs.readdirSync(path.join(tmp, "out")) : [], [], "no partial output left behind");
    console.log("ok  tampering is detected");

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log("\nAll pairing tests passed");
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
