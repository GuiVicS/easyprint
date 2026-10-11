'use strict';
// Implementação mínima de WebSocket (RFC 6455) para o lado servidor, sem dependências.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 48 * 1024 * 1024; // 48 MB por mensagem (PDF de 25 MB em base64 cabe)

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.origin = req.headers.origin || null;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this._parseFrame();
      if (!frame) return;
      if (frame.error) { this.close(1009, frame.error); return; }
      this._handleFrame(frame);
    }
  }

  _parseFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2); offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) return { error: 'Mensagem grande demais' };
      len = Number(big); offset = 10;
    }
    if (len > MAX_PAYLOAD) return { error: 'Mensagem grande demais' };
    const maskLen = masked ? 4 : 0;
    if (b.length < offset + maskLen + len) return null;
    let payload = b.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = b.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buffer = b.subarray(offset + maskLen + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuação
        this.fragments.push(payload);
        if (fin) this._message(this.fragmentOpcode, Buffer.concat(this.fragments));
        break;
      case 0x1:
      case 0x2:
        if (fin) this._message(opcode, payload);
        else { this.fragmentOpcode = opcode; this.fragments = [payload]; }
        break;
      case 0x8: this.close(1000); break;
      case 0x9: this._send(0xA, payload); break; // ping -> pong
      case 0xA: break; // pong
      default: this.close(1002, 'Opcode inválido');
    }
  }

  _message(opcode, data) {
    this.fragments = [];
    this.emit('message', opcode === 0x1 ? data.toString('utf8') : data);
  }

  _send(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this._send(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8');
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._send(0x8, p);
    this.open = false;
    this.socket.end();
    this.emit('close');
  }
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  return new WebSocketConnection(socket, req);
}

module.exports = { handleUpgrade, acceptKey };
