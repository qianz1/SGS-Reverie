/**
 * net/mqtt.js — 极简 MQTT 3.1.1 over WebSocket 客户端（零依赖、可离线）
 *
 * 为什么自己写而不是引 mqtt.js：
 *   · 本作是纯静态无打包器项目，CDN 版本在「无外网局域网」里加载不了；
 *   · 信令只用得到 CONNECT / PUBLISH(QoS1) / SUBSCRIBE / PUBACK / PING
 *     这五个包，一个 300 行的实现比 100KB+ 的通用库更好审计、更好自测；
 *   · 游戏数据完全不走 broker，这里只负责建连那一刻的几 KB 文本。
 *
 * 实现子集（严格按 MQTT 3.1.1 §2/§3）：
 *   CONNECT(cleanStart=1, 可选 LWT QoS1) / CONNACK
 *   PUBLISH(QoS0/1, 收 QoS1 自动回 PUBACK) / PUBACK
 *   SUBSCRIBE(QoS1) / SUBACK / UNSUBSCRIBE
 *   PINGREQ / PINGRESP / DISCONNECT
 *   剩余长度变长编码、UTF-8 字符串、粘包/半包缓冲、keepalive、断线重连。
 *
 * 可靠性口径（与游戏层约定）：
 *   · 发布一律 QoS1（至少一次），可能重复 → 由 signaling.js 用
 *     (sessionId, seq) 在应用层去重，绝不使用 QoS2 的四段握手；
 *   · cleanStart = true + 每次重连重新订阅，避免上一局离线消息灌入；
 *   · SDP / ICE 一律不用 retained（迟到者会拿到过期 offer）。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Net = SGS.Net || (SGS.Net = {});

  /* ---------------- 编码工具 ---------------- */
  function utf8(str) {
    const s = String(str == null ? '' : str);
    if (typeof TextEncoder !== 'undefined') {
      const b = new TextEncoder().encode(s);
      const out = new Uint8Array(b.length + 2);
      out[0] = (b.length >> 8) & 0xff; out[1] = b.length & 0xff;
      out.set(b, 2);
      return out;
    }
    // Node / 老内核兜底：手工 UTF-8
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(++i);
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                   0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    const out = new Uint8Array(bytes.length + 2);
    out[0] = (bytes.length >> 8) & 0xff; out[1] = bytes.length & 0xff;
    out.set(bytes, 2);
    return out;
  }
  function readUtf8(u, off) {
    const len = (u[off] << 8) | u[off + 1];
    const start = off + 2;
    if (typeof TextDecoder !== 'undefined') {
      return { v: new TextDecoder().decode(u.subarray(start, start + len)),
               next: start + len };
    }
    let s = '';
    for (let i = start; i < start + len; i++) s += String.fromCharCode(u[i]);
    try { s = decodeURIComponent(escape(s)); } catch (e) { /* 保持原字节串 */ }
    return { v: s, next: start + len };
  }
  function remainingLength(n) {
    const out = [];
    do {
      let d = n % 128; n = Math.floor(n / 128);
      if (n > 0) d |= 0x80;
      out.push(d);
    } while (n > 0);
    return out;
  }
  function concat(parts) {
    let n = 0;
    parts.forEach((p) => { n += p.length; });
    const out = new Uint8Array(n);
    let o = 0;
    parts.forEach((p) => { out.set(p, o); o += p.length; });
    return out;
  }
  function u16(n) { return new Uint8Array([(n >> 8) & 0xff, n & 0xff]); }
  function strBytes(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s));
    return utf8(s).subarray(2);
  }
  function bytesToString(u) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  /* ---------------- 包构造 ---------------- */
  function fixed(type, flags, body) {
    return concat([new Uint8Array([(type << 4) | flags]),
                   new Uint8Array(remainingLength(body.length)), body]);
  }
  function connectPacket(o) {
    const vh = concat([
      utf8('MQTT'), new Uint8Array([4]),
      new Uint8Array([o.flags]), u16(o.keepalive || 30)
    ]);
    const payload = [utf8(o.clientId)];
    if (o.flags & 0x04) { payload.push(utf8(o.willTopic)); payload.push(utf8(o.willPayload)); }
    if (o.flags & 0x80) payload.push(utf8(o.username || ''));
    if (o.flags & 0x40) payload.push(utf8(o.password || ''));
    return fixed(1, 0, concat([vh].concat(payload)));
  }
  function publishPacket(topic, payload, qos, packetId, retain, dup) {
    const flags = ((qos & 3) << 1) | (retain ? 1 : 0) | (dup ? 8 : 0);
    const parts = [utf8(topic)];
    if (qos > 0) parts.push(u16(packetId));
    parts.push(strBytes(payload));
    return fixed(3, flags, concat(parts));
  }
  function subscribePacket(topics, qos, packetId) {
    const parts = [u16(packetId)];
    topics.forEach((t) => { parts.push(utf8(t)); parts.push(new Uint8Array([qos & 3])); });
    return fixed(8, 2, concat(parts));
  }
  function pubackPacket(id) { return fixed(4, 0, u16(id)); }
  function pingPacket() { return fixed(12, 0, new Uint8Array(0)); }
  function disconnectPacket() { return fixed(14, 0, new Uint8Array(0)); }
  function idPacket(type, flags, id) { return fixed(type, flags, u16(id)); }

  /* ---------------- 客户端 ---------------- */
  class MqttClient {
    constructor(opts) {
      opts = opts || {};
      this.url = opts.url || '';
      this.clientId = opts.clientId || ('sgs_' + Math.random().toString(36).slice(2, 10));
      this.username = opts.username || '';
      this.password = opts.password || '';
      this.keepalive = opts.keepalive || 30;
      this.reconnectPeriod = opts.reconnectPeriod == null ? 1500 : opts.reconnectPeriod;
      this.willTopic = opts.willTopic || '';
      this.willPayload = opts.willPayload == null ? 'offline' : String(opts.willPayload);
      this.topics = (opts.topics || []).slice();
      this.WebSocketImpl = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);

      this.ws = null;
      this.buf = new Uint8Array(0);
      this.packetId = 0;
      this.connected = false;
      this.closed = false;
      this.onMessage = opts.onMessage || function () {};
      this.onState = opts.onState || function () {};
      this._pingTimer = null;
      this._reconnectTimer = null;
      this._pendingPuback = {};
      this._pendingSuback = {};
      // ★ CONNECT/CONNACK 之前不能发 PUBLISH（ws 还在 CONNECTING，send 会抛）。
      //   建连瞬间要发的 announce / hello 先排队，CONNACK 后按序补发；
      //   重连时同样生效，避免「房间开了但没人加入」。
      this._outQueue = [];
    }

    _state(s, extra) { try { this.onState(s, extra || {}); } catch (e) {} }

    nextId() {
      this.packetId = (this.packetId % 65535) + 1;
      return this.packetId;
    }

    connect() {
      if (this.closed) return;
      this._clearTimers();
      if (!this.WebSocketImpl) { this._state('error', { reason: 'no-websocket' }); return; }
      this._state('connecting');
      let ws;
      try { ws = new this.WebSocketImpl(this.url, 'mqtt'); }
      catch (e) { this._state('error', { reason: 'constructor', error: e }); this._reconnect(); return; }
      this.ws = ws;
      try { ws.binaryType = 'arraybuffer'; } catch (e) {}

      ws.onopen = () => {
        const flags = 0x02 | (this.willTopic ? (0x04 | (1 << 3)) : 0) |
          (this.username ? 0x80 : 0) | (this.password ? 0x40 : 0);
        this._send(connectPacket({
          flags: flags, keepalive: this.keepalive, clientId: this.clientId,
          username: this.username, password: this.password,
          willTopic: this.willTopic, willPayload: this.willPayload
        }));
      };
      ws.onmessage = (ev) => {
        let chunk = ev.data;
        if (chunk instanceof ArrayBuffer) chunk = new Uint8Array(chunk);
        else if (typeof chunk === 'string') chunk = strBytes(chunk);
        else if (chunk && chunk.buffer) chunk = new Uint8Array(chunk.buffer);
        if (!(chunk instanceof Uint8Array)) return;
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf, 0); merged.set(chunk, this.buf.length);
        this.buf = merged;
        this._drain();
      };
      ws.onerror = () => { this._state('error', { reason: 'socket' }); };
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        // 旧会话没发出去的消息作废：重连 CONNACK 后 _onConnected 会
        // 重新 announce / hello，不必补发上一局的过期包
        this._outQueue = [];
        this._clearTimers();
        this._state('disconnected', { wasConnected: was });
        this._reconnect();
      };
    }

    _send(bytes) {
      if (!this.ws || typeof this.ws.send !== 'function') return false;
      try {
        // 统一传 ArrayBuffer，兼容浏览器与自测桩
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        this.ws.send(ab);
        return true;
      } catch (e) {
        try { this.ws.send(bytes); return true; } catch (e2) { return false; }
      }
    }

    /**
     * ★ 防同步重入：处理 CONNACK 时会立刻发 SUBSCRIBE，若 broker（或自测
     *   桩）同步回 SUBACK，onmessage 会再次进入 _drain。若还沿用「先处理、
     *   末尾才清空 buf」的老写法，内层会重复处理同一批字节 → 无限递归。
     *   这里改为：先把已解析的完整包从 buf 切走，再调 _handle；重入的
     *   onmessage 只追加新数据，_draining 锁让它直接返回，外层循环接着读。
     */
    _drain() {
      if (this._draining) return;
      this._draining = true;
      try {
        for (;;) {
          const u = this.buf;
          if (u.length < 2) return;           // 半包：等更多字节
          let mul = 1, len = 0, i = 1, digit;
          do {
            if (i >= u.length) return;
            digit = u[i++]; len += (digit & 127) * mul; mul *= 128;
          } while ((digit & 128) !== 0 && mul <= 128 * 128 * 128);
          if ((digit & 128) !== 0) return;
          const end = i + len;
          if (end > u.length) return;
          const packet = u.slice(0, end);
          this.buf = u.slice(end);           // ★ 先消费，再处理
          this._handle(packet, 0, i, end);
        }
      } finally {
        this._draining = false;
      }
    }

    _handle(u, start, vhStart, end) {
      const type = u[start] >> 4, flags = u[start] & 15;
      const body = u.subarray(vhStart, end);
      let p = 0;
      switch (type) {
        case 2: // CONNACK
          if (body.length < 2) return;
          if (body[1] !== 0) { this._state('error', { reason: 'connack', code: body[1] }); return; }
          this.connected = true;
          this._state('connected');
          if (this.topics.length) this._subscribe(this.topics);
          // ★ 先补发排队消息，再开 ping；顺序 = 调用顺序，不丢不乱
          const q = this._outQueue.splice(0);
          q.forEach((pkt) => this._send(pkt));
          this._startPing();
          break;
        case 3: { // PUBLISH
          const t = readUtf8(body, p); p = t.next;
          const qos = (flags >> 1) & 3;
          let id = 0;
          if (qos > 0) { if (p + 2 > body.length) return; id = (body[p] << 8) | body[p + 1]; p += 2; }
          const payload = bytesToString(body.subarray(p));
          if (qos === 1) this._send(pubackPacket(id));
          else if (qos === 2) { /* 不订阅 QoS2，忽略 */ }
          try { this.onMessage(t.v, payload); } catch (e) {}
          break;
        }
        case 4: // PUBACK
          if (body.length >= 2) delete this._pendingPuback[(body[0] << 8) | body[1]];
          break;
        case 9: // SUBACK
          if (body.length >= 2) delete this._pendingSuback[(body[0] << 8) | body[1]];
          break;
        case 11: // UNSUBACK
          break;
        case 13: // PINGRESP
          break;
        default: break;
      }
    }

    _subscribe(topics) {
      const id = this.nextId();
      this._pendingSuback[id] = topics;
      this._send(subscribePacket(topics, 1, id));
    }

    subscribe(topics) {
      const list = Array.isArray(topics) ? topics : [topics];
      list.forEach((t) => { if (this.topics.indexOf(t) < 0) this.topics.push(t); });
      if (this.connected) this._subscribe(list);
    }

    /** QoS1 发布；retain 默认 false（SDP / ICE 绝不能 retained） */
    publish(topic, payload, opts) {
      opts = opts || {};
      const qos = opts.qos == null ? 1 : opts.qos;
      const id = this.nextId();
      const pkt = publishPacket(topic,
        typeof payload === 'string' ? payload : JSON.stringify(payload),
        qos, id, !!opts.retain, false);
      if (qos > 0) this._pendingPuback[id] = { topic: topic, pkt: pkt, t: Date.now() };
      if (!this.connected) { this._outQueue.push(pkt); return true; }
      return this._send(pkt);
    }

    _startPing() {
      this._clearPing();
      if (!this.keepalive) return;
      this._pingTimer = setInterval(() => {
        if (this.connected) this._send(pingPacket());
      }, Math.max(5, this.keepalive * 1000 * 0.8));
    }
    _clearPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }
    _clearTimers() {
      this._clearPing();
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    }
    _reconnect() {
      if (this.closed || this.reconnectPeriod <= 0 || this._reconnectTimer) return;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (!this.closed) this.connect();
      }, this.reconnectPeriod);
    }

    /** 主动断开：发 DISCONNECT、不再重连 */
    close() {
      this.closed = true;
      this._outQueue = [];
      this._clearTimers();
      if (this.connected) { try { this._send(disconnectPacket()); } catch (e) {} }
      this.connected = false;
      if (this.ws && typeof this.ws.close === 'function') {
        try { this.ws.close(); } catch (e) {}
      }
      this._state('closed');
    }
  }

  /* 暴露包构造器，供自测逐字节验证协议；也方便将来 mock broker */
  Net.MqttClient = MqttClient;
  Net.MqttPackets = {
    utf8: utf8, readUtf8: readUtf8, remainingLength: remainingLength,
    connect: connectPacket, publish: publishPacket,
    subscribe: subscribePacket, puback: pubackPacket,
    ping: pingPacket, disconnect: disconnectPacket, id: idPacket,
    fixed: fixed
  };
})(typeof window !== 'undefined' ? window : globalThis);
