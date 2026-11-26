/**
 * net/signaling.js — MQTT 信令层（平时只承载建连那几 KB）
 *
 * 这正是「取其精华」的落点：
 *   · 之前 MQTT 方案拉胯，是因为每个游戏动作都经 broker，再叠 QoS 排队 /
 *     重传与 TCP 队头阻塞；现在 MQTT 平时只在开局交换 offer/answer/ICE，
 *     之后即使 broker 挂了，对局照常跑。
 *   · ★ 例外：WebRTC 打洞失败时，Session 会切到「公网中继」——
 *     游戏帧也经这台 broker 的 inbox 转发（地址与信令完全一致），
 *     保证打不通 P2P 的两位玩家也能把对局打完。
 *   · 之前「加入房间容易失败」靠的是 MQTT 的长连接 + 自动重订阅 + LWT；
 *     这些能力保留，而且 SDP 绝不放 retained（迟到者会拿到过期 offer）。
 *
 * 配置口径：
 *   · QoS1（至少一次）→ 会重复，所以每条带 (from, seq)，接收端去重；
 *     绝不用 QoS2 的四段握手；
 *   · cleanStart=true + 重连后重新订阅，避免上一局的离线消息灌入；
 *   · retained 只用于「房间存在 / 房主是谁」这类状态，且带 epoch，
 *     退房发空 payload 清除；
 *   · 每条消息带 sid（一次 PeerConnection 一个），ICE restart 前的迟到
 *     消息直接丢掉（Trickle ICE RFC 8838 §9 的相关性要求）。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Net = SGS.Net || (SGS.Net = {});
  const APP = 'sgs1v1';
  const VERSION = 1;

  class Signaling {
    constructor(opts) {
      opts = opts || {};
      this.brokerUrl = opts.brokerUrl || '';
      this.appId = opts.appId || 'sanguosha';   // 公共 broker 上避免撞车
      this.room = String(opts.room || '').replace(/[^\w-]/g, '').slice(0, 24);
      this.role = opts.role === 'host' ? 'host' : 'guest';
      this.peerId = opts.peerId ||
        (this.role === 'host' ? 'H' : 'G') + Math.random().toString(36).slice(2, 8);
      this.sid = opts.sid || ('s' + Math.random().toString(36).slice(2, 10));
      this.username = opts.username || '';
      this.password = opts.password || '';
      this.hostPeerId = opts.hostPeerId || (this.role === 'host' ? this.peerId : '');

      this.seq = 0;
      this._seen = {};          // from -> 最大已处理 seq / 集合
      this._seenSet = {};
      this._pending = [];       // answer 之前的早到消息缓冲
      this.remoteReady = false;
      this.onSignal = opts.onSignal || function () {};   // (type, data, from)
      this.onState = opts.onState || function () {};    // (state, extra)
      this.onPresence = opts.onPresence || function () {};
      // ★ 公网中继兜底：P2P 打不通时，游戏帧改由同一个 broker 转发。
      //   地址就是本文件连的信令地址 —— 不额外部署任何服务。
      this.onRelay = opts.onRelay || function () {};    // (frame)

      const self = this;
      this.inbox = this.topic('inbox/' + this.peerId);
      this.presenceTopic = this.topic('presence');
      // ★ bye / LWT 与 room 状态同走 presence，所有人已订阅 → 掉线感知真正生效。
      this.byeTopic = this.presenceTopic;
      const topics = [this.inbox, this.presenceTopic];

      this.mqtt = new Net.MqttClient({
        url: this.brokerUrl,
        clientId: APP + '_' + this.peerId,
        username: this.username, password: this.password,
        keepalive: 25,
        reconnectPeriod: opts.reconnectPeriod == null ? 1500 : opts.reconnectPeriod,
        topics: topics,
        willTopic: this.byeTopic,
        willPayload: JSON.stringify({ app: APP, type: 'bye', peer: this.peerId,
          role: this.role }),
        WebSocketImpl: opts.WebSocketImpl,
        // ★ 每次（含重连）CONNACK 后才发 announce / hello：
        //   MqttClient 会把 CONNECT 前的 PUBLISH 排队，但「重连后刷新
        //   retained 房间状态 / 重新打招呼」必须由这里驱动。
        onState: (s, x) => { if (s === 'connected') self._onConnected(); self.onState(s, x); },
        onMessage: (t, payload) => self._onMqtt(t, payload)
      });
    }

    topic(suffix) { return APP + '/' + this.appId + '/' + this.room + '/' + suffix; }

    start() { this.mqtt.connect(); return this; }

    /** 连接就绪（每次重连都会触发）：房主刷 retained 状态，客机打招呼 */
    _onConnected() {
      if (this.role === 'host') this.announce();
      else this.hello();
    }

    /** 房主广播「房间已开」（retained 状态，不是 SDP，且带 epoch） */
    announce() {
      this.mqtt.publish(this.presenceTopic, JSON.stringify({
        app: APP, v: VERSION, type: 'room', room: this.room,
        hostPeerId: this.peerId, epoch: Date.now()
      }), { qos: 1, retain: true });
    }

    /** 客机宣布加入：只发给房主的 inbox */
    hello(extra) {
      this._send('hello', Object.assign({ role: this.role }, extra || {}));
    }

    _envelope(type, data) {
      this.seq += 1;
      return {
        app: APP, v: VERSION, sid: this.sid,
        seq: this.seq, from: this.peerId,
        to: this.role === 'host' ? this.hostPeerId : '',
        type: type, data: data || {}
      };
    }

    _send(type, data) {
      const msg = this._envelope(type, data);
      // to 为空（客机→房主）时按角色补上
      if (this.role === 'host') msg.to = this.hostPeerId === this.peerId
        ? (this.guestPeerId || '') : this.hostPeerId;
      else msg.to = this.hostPeerId || '';
      const topic = msg.to
        ? this.topic('inbox/' + msg.to)
        : this.presenceTopic;   // 还没确定对端时走房间广播
      this.mqtt.publish(topic, JSON.stringify(msg), { qos: 1, retain: false });
      return msg;
    }

    /** 发给 Transport 的 onSignal 用：统一走 _send */
    sendSignal(type, data) { return this._send(type, data); }

    /**
     * ★ 公网中继：把一帧游戏数据经 broker 转发给对方。
     *   P2P（WebRTC）打洞失败时由 Session 调用，每次一发一条 inbox 消息，
     *   仍带 (from, seq) 去重，QoS1 重发不会让动作执行两次。
     */
    sendRelay(frame) { return this._send('relay', frame || {}); }

    _onMqtt(topic, payload) {
      let msg;
      try { msg = JSON.parse(payload); } catch (e) { return; }
      if (!msg || msg.app !== APP) return;

      // ★ presence 上只有 room 状态是「纯广播」；客机在对端 peerId
      //   还没确定时，hello 也会临时发到 presence，必须继续往下投递，
      //   否则房主收不到 hello → 不发 offer → 表现就是「加入房间失败」。
      if (msg.type === 'room') {
        if (msg.hostPeerId) {
          this.hostPeerId = msg.hostPeerId;
          try { this.onPresence(msg); } catch (e) {}
        }
        return;
      }
      if (msg.type === 'offline' || msg.type === 'bye') {
        try { this.onPresence(msg); } catch (e) {}
        return;
      }
      // 只处理发给自己的（或 to 为空的广播）
      if (msg.to && msg.to !== this.peerId) return;
      if (msg.from === this.peerId) return;

      // ★ 去重：QoS1 至少一次，broker 重发必须按 (from, seq) 丢弃
      const key = msg.from || '?';
      const set = this._seenSet[key] || (this._seenSet[key] = {});
      if (set[msg.seq]) return;
      set[msg.seq] = true;
      this._seen[key] = Math.max(this._seen[key] || 0, msg.seq || 0);
      // 集合只留最近 512 条，避免长局无限增长
      const keys = Object.keys(set);
      if (keys.length > 512) keys.slice(0, 256).forEach((k) => delete set[k]);

      // 记住对端 peerId
      if (msg.role === 'guest' || (this.role === 'host' && msg.type === 'hello')) {
        this.guestPeerId = msg.from;
        this.hostPeerId = this.peerId;
      }
      if (this.role === 'guest' && msg.from) this.hostPeerId = msg.from;

      if (msg.type === 'hello') { this.remoteReady = true; this._flush(); }
      if (msg.type === 'offer' || msg.type === 'answer') this.remoteReady = true;

      // ★ 公网中继帧：与 PeerConnection 无关，不做 sid 过滤
      //   （ICE restart 会换 sid，但中继本来就绕过了它）。
      if (msg.type === 'relay') {
        try { this.onRelay(msg.data || {}); } catch (e) {}
        return;
      }

      // sid 不匹配（ICE restart 之前的旧会话）直接丢
      if (msg.sid && this.sid && msg.sid !== this.sid &&
          msg.type !== 'hello' && msg.type !== 'bye') {
        // 允许新会话的第一条 offer 刷新 sid
        if (msg.type === 'offer') this.sid = msg.sid;
        else return;
      }

      const deliver = () => {
        try { this.onSignal(msg.type, msg.data || {}, msg.from); } catch (e) {}
      };
      // answer 之前的 candidate 先缓冲（Trickle ICE 的顺序要求）
      if (msg.type === 'candidate' && !this.remoteReady) this._pending.push(deliver);
      else deliver();
    }
    _flush() {
      const list = this._pending.splice(0);
      list.forEach((fn) => fn());
    }

    /** 主动退房：清 retained 状态 + 发 bye + 断开 */
    close() {
      try {
        if (this.role === 'host') {
          this.mqtt.publish(this.presenceTopic, '', { qos: 1, retain: true });
        }
        this.mqtt.publish(this.byeTopic, JSON.stringify({
          app: APP, type: 'bye', peer: this.peerId
        }), { qos: 1, retain: false });
      } catch (e) {}
      this.mqtt.close();
    }
  }

  Net.Signaling = Signaling;
  Net.SIGNAL_APP = APP;
})(typeof window !== 'undefined' ? window : globalThis);
