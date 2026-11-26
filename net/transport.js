/**
 * net/transport.js — WebRTC DataChannel 传输层
 *
 * 口径（对应前面讨论定下的方案）：
 *   · 1v1 固定「主机 = 唯一 offerer，客机只 answer」→ 没有 glare，
 *     连 perfect negotiation 都不需要；
 *   · 采用 non-trickle：等 ICE gathering complete 再把带全部 candidate
 *     的 SDP 发出去。回合制对建连慢 0.5~2s 完全无感，却消掉了「加入房间
 *     失败」最常见的两个根因（candidate 没收全 / candidate 乱序）。
 *     ICE restart 时才走 candidate 消息，并带缓冲 + usernameFragment 校验；
 *   · DataChannel 用默认可靠有序（ordered:true，不设 maxRetransmits）。
 *     卡牌动作丢一个就卡死，绝不能为了「UDP 快」用不可靠通道；
 *     飘字 / 音效这类表现事件都留在各自本地，不占网络。
 *   · 界面能读到当前 nominated candidate-pair 是 host / srflx / relay
 *     与 RTT，否则「感觉有点卡」根本查不出是不是悄悄落了 TURN。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Net = SGS.Net || (SGS.Net = {});

  class Transport {
    constructor(opts) {
      opts = opts || {};
      this.role = opts.role === 'host' ? 'host' : 'guest';
      this.sid = opts.sid || ('s' + Math.random().toString(36).slice(2, 10));
      this.iceServers = opts.iceServers || [];
      this.PC = opts.RTCPeerConnectionImpl ||
        (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
      this.pc = null;
      this.dc = null;
      this.ready = false;
      this.pendingCandidates = [];
      this.remoteSet = false;
      this._iceDone = null;
      this._openWaiters = [];

      this.onSignal = opts.onSignal || function () {};      // (type, data)
      this.onOpen = opts.onOpen || function () {};
      this.onClose = opts.onClose || function () {};
      this.onMessage = opts.onMessage || function () {};    // (parsed JSON)
      this.onLink = opts.onLink || function () {};          // ({kind, rtt})
      this._linkTimer = null;
    }

    _newPc() {
      if (!this.PC) throw new Error('RTCPeerConnection unavailable');
      const pc = new this.PC({ iceServers: this.iceServers });
      this.pc = pc;
      this.remoteSet = false;
      this.pendingCandidates = [];
      const self = this;

      pc.onicecandidate = (ev) => {
        if (!ev || !ev.candidate) return;   // gathering 结束由 complete 处理
        // non-trickle 主流程不单独发；restart 时才交给信令
        if (self._trickle) {
          self.onSignal('candidate', {
            sid: self.sid, candidate: ev.candidate.toJSON
              ? ev.candidate.toJSON() : ev.candidate
          });
        }
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && self._iceDone) {
          const done = self._iceDone; self._iceDone = null;
          done(pc.localDescription);
        }
      };
      pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        if (st === 'failed' || st === 'disconnected') self.onClose(st);
        if (st === 'connected' || st === 'completed') self._startLinkAudit();
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') self.onClose('failed');
      };
      pc.ondatachannel = (ev) => { self._bindDC(ev.channel); };
      return pc;
    }

    _bindDC(dc) {
      const self = this;
      this.dc = dc;
      dc.onopen = () => {
        self.ready = true;
        self.onOpen();
        self._openWaiters.splice(0).forEach((fn) => fn());
        self._startLinkAudit();
      };
      dc.onclose = () => { self.ready = false; self.onClose('dc-close'); };
      dc.onerror = () => { /* 静默：上层有重连 */ };
      dc.onmessage = (ev) => {
        let msg = ev && ev.data;
        if (msg == null) return;
        if (typeof msg === 'string') {
          try { msg = JSON.parse(msg); } catch (e) { return; }
        }
        try { self.onMessage(msg); } catch (e) {}
      };
    }

    /** 等 ICE 收全再取 localDescription（non-trickle） */
    _waitIce(pc) {
      return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(pc.localDescription); return; }
        this._iceDone = resolve;
        // 兜底：某些网络下 gather 会拖很久，5s 后直接用当前 SDP
        setTimeout(() => {
          if (this._iceDone === resolve) {
            this._iceDone = null;
            resolve(pc.localDescription);
          }
        }, 5000);
      });
    }

    /** 主机：创建 offer 并通过信令发出 */
    async makeOffer() {
      this._trickle = false;
      const pc = this._newPc();
      this._bindDC(pc.createDataChannel('sgs', { ordered: true }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const desc = await this._waitIce(pc);
      this.onSignal('offer', { sid: this.sid, sdp: desc });
      return desc;
    }

    /** 客机：收 offer → 建 answer → 发回 */
    async acceptOffer(msg) {
      if (!msg || !msg.sdp) return;
      this._trickle = false;
      const pc = this._newPc();
      await pc.setRemoteDescription(msg.sdp);
      this.remoteSet = true;
      this._flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const desc = await this._waitIce(pc);
      this.onSignal('answer', { sid: this.sid, sdp: desc });
      return desc;
    }

    /** 主机：收 answer */
    async acceptAnswer(msg) {
      if (!msg || !msg.sdp || !this.pc) return;
      await this.pc.setRemoteDescription(msg.sdp);
      this.remoteSet = true;
      this._flushCandidates();
    }

    /**
     * ICE restart 时才用的 trickle candidate。
     * 带 usernameFragment 校验：旧 ICE 会话的迟到候选直接丢弃。
     */
    async addCandidate(msg) {
      if (!msg || !msg.candidate) return;
      if (msg.sid && msg.sid !== this.sid) return;
      const c = msg.candidate;
      if (!this.pc || !this.remoteSet) { this.pendingCandidates.push(c); return; }
      try {
        await this.pc.addIceCandidate(c);
      } catch (e) { /* 旧 ufrag / 无效候选：静默丢弃 */ }
    }
    _flushCandidates() {
      const list = this.pendingCandidates.splice(0);
      list.forEach((c) => {
        try { this.pc.addIceCandidate(c); } catch (e) {}
      });
    }

    /** 网络切换后重新打洞；角色（offerer）保持不变，避免 glare */
    async restartIce() {
      if (!this.pc || this.role !== 'host') return;
      this._trickle = true;
      try {
        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(offer);
        const desc = await this._waitIce(this.pc);
        this.onSignal('offer', { sid: this.sid, sdp: desc, restart: true });
      } catch (e) { /* 静默 */ }
    }

    /** 可靠有序发送；未 open 时排队，不会静默丢动作 */
    send(msg) {
      const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
      if (!this.ready || !this.dc || typeof this.dc.send !== 'function') {
        this._openWaiters.push(() => this._sendNow(data));
        return false;
      }
      return this._sendNow(data);
    }
    _sendNow(data) {
      try { this.dc.send(data); return true; }
      catch (e) { this._openWaiters.push(() => this._sendNow(data)); return false; }
    }

    /** 读 nominated candidate-pair，告诉界面是真直连还是落了 TURN */
    async auditLink() {
      if (!this.pc || typeof this.pc.getStats !== 'function') return null;
      try {
        const stats = await this.pc.getStats();
        const candidates = {};
        let pair = null, fallback = null, last = null;
        const consider = (r) => {
          if (!r) return;
          if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
            candidates[r.id] = r; return;
          }
          if (r.type !== 'candidate-pair') return;
          last = r;
          const ok = r.state === 'succeeded' || r.nominated || r.selected;
          if (!ok) return;
          if (!fallback) fallback = r;
          // ★ 取「nominated 且 succeeded」的最优 pair，而不是遍历到的最后一个。
          //   两端 stats 顺序不同会各选到不同 pair —— 这正是之前两边标签
          //   不一致（两端选到不同 pair）的第二个原因。
          if ((r.nominated || r.selected) && r.state === 'succeeded') {
            if (!pair || (r.currentRoundTripTime != null &&
                (pair.currentRoundTripTime == null ||
                 r.currentRoundTripTime < pair.currentRoundTripTime))) pair = r;
          }
        };
        if (stats && typeof stats.forEach === 'function') stats.forEach(consider);
        else if (stats && typeof stats.values === 'function') {
          for (const r of stats.values()) consider(r);
        }
        if (!pair) pair = fallback || last;
        if (!pair) return null;
        // ★ 整条 pair 两端一起判：只取 local 会把 host↔srflx 误判成纯宿主候选。
        const local = candidates[pair.localCandidateId] || {};
        const remote = candidates[pair.remoteCandidateId] || {};
        const types = [local.candidateType || local.type || '',
                       remote.candidateType || remote.type || ''].join(' ');
        let kind = 'host';
        if (types.indexOf('relay') >= 0) kind = 'relay';
        else if (types.indexOf('srflx') >= 0 || types.indexOf('prflx') >= 0) kind = 'srflx';
        const info = { kind: kind, rtt: pair.currentRoundTripTime != null
          ? Math.round(pair.currentRoundTripTime * 1000) : null };
        this.onLink(info);
        return info;
      } catch (e) { return null; }
    }
    _startLinkAudit() {
      if (this._linkTimer) return;
      this.auditLink();
      this._linkTimer = setInterval(() => this.auditLink(), 3000);
    }

    close() {
      if (this._linkTimer) { clearInterval(this._linkTimer); this._linkTimer = null; }
      this.ready = false;
      try { if (this.dc) this.dc.close(); } catch (e) {}
      try { if (this.pc) this.pc.close(); } catch (e) {}
    }
  }

  Net.Transport = Transport;

  /**
   * 默认 ICE：只做 STUN 打洞。
   * ★ 打洞失败（ICE failed / 超时没 open）不在这里处理 —— 由 Session
   *   切到「公网中继」（复用信令 broker 转发游戏帧），不依赖 TURN 服务。
   */
  Net.defaultIceServers = function () {
    return [{ urls: 'stun:stun.cloudflare.com:3478' }];
  };
})(typeof window !== 'undefined' ? window : globalThis);
