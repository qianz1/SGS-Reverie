/**
 * net/session.js — 联机会话编排（主机权威 / 客机视图 / 联机面板）
 *
 * 架构三层（对应前面定下的口径）：
 *   Pages 静态前端  →  MQTT over WSS 建连信令  →  WebRTC DataChannel 直传
 *   主机浏览器跑完整 SGS.Game（唯一权威），客机只有一个「视图 Game」。
 *   ★ P2P 打洞失败（ICE failed / 超时未 open）时自动改走「公网中继」：
 *     游戏帧经同一台 broker 转发（地址即信令地址），对局不中断。
 *
 * 最小侵入的关键 —— RouterUI：
 *   Game 里所有决策都是 `if (decider) await this.ui.waitXxx(...)`。
 *   联机时把 this.ui 换成一个路由器：按 waitXxx 的「决策者参数」判断，
 *   本地真人 → 真实 UI，远端玩家 → RemoteUI（发 ask / 等 act），
 *   其余 render / log / 动画方法一律转发给本地 UI。
 *   因此规则结算、牌序、判定、AI 全部一行没改，单机路径完全等价。
 *
 * 客机为什么能原样复用整套战斗 UI：
 *   收到 ask 后直接调用自己的真实 ui[method](...解包参数)，界面照常渲染；
 *   再把 ui.pending.resolve 换成「把 finish() 的值发给主机」。所有选牌、
 *   选目标、五谷、火计看牌、无懈嵌套链都在本地完成，只有最终动作上送。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Net = SGS.Net || (SGS.Net = {});
  const P = Net.Protocol;
  const CFG_KEY = 'sgs_net_cfg_v1';

  /* ================= 配置 ================= */
  // ★ 默认走公共 broker；P2P 打不通时游戏帧也经它转发（公网中继兜底），
  //   所以这里既是信令地址也是中继地址。
  // ★ 想完全自建（frp 内网穿透）时，在联机面板里填自建地址即可：
  //   房主电脑跑 `node server/broker.js 8080`，frpc 把 8080 映射到公网，
  //   玩家填 ws://公网IP:端口/mqtt（直接粘 http://IP:端口 也能自动纠正）。
  const DEFAULTS = {
    brokerUrl: 'wss://broker-cn.emqx.io:8084/mqtt', appId: 'sanguosha',
    token: ''
  };
  const Config = Net.Config = {
    DEFAULTS: DEFAULTS,
    /** 空值 / 非法值一律丢掉，免得 localStorage 里一条空串把默认地址顶掉 */
    _clean(obj) {
      const out = {};
      Object.keys(obj || {}).forEach((k) => {
        const v = obj[k];
        if (v == null || v === '') return;
        if (k === 'brokerUrl') {
          // 按页面协议补前缀：https 页面存下来就是 wss://
          const n = Net.normalizeBrokerUrl(v, (global.location || {}).protocol || '');
          if (n) out[k] = n;
          return;
        }
        out[k] = v;
      });
      return out;
    },
    load() {
      let saved = {};
      try { saved = JSON.parse(global.localStorage && global.localStorage.getItem(CFG_KEY) || '{}'); }
      catch (e) { saved = {}; }
      const url = Net.Config.fromUrl();
      return Object.assign({}, DEFAULTS,
        Config._clean(saved), Config._clean(url));
    },
    save(cfg) {
      const out = { appId: cfg.appId || 'sanguosha' };
      // ★ 只把「非默认」的自建地址落盘：换回公共服务器时不该留下陈旧地址
      if (cfg.brokerUrl && cfg.brokerUrl !== DEFAULTS.brokerUrl) {
        const n = Net.normalizeBrokerUrl(cfg.brokerUrl,
          (global.location || {}).protocol || '');
        if (n) out.brokerUrl = n;
      }
      if (cfg.token) out.token = String(cfg.token);
      try { global.localStorage && global.localStorage.setItem(CFG_KEY,
        JSON.stringify(out)); } catch (e) {}
    },
    fromUrl() {
      const out = {};
      try {
        const q = new URLSearchParams(global.location ? global.location.search : '');
        [['broker', 'brokerUrl'], ['appid', 'appId'], ['room', 'room'],
         // ★ 自建中继口令：房主分享 /?token=xxx 时，客人打开就自带
         ['token', 'token']]
          .forEach(([k, v]) => { if (q.get(k)) out[v] = q.get(k); });
      } catch (e) {}
      return out;
    }
  };

  /**
   * ★ 中继连通性探测：联机面板的「测试」按钮用，也方便排障脚本直接调。
   *   只完成一次 MQTT CONNECT 就断开，不发任何业务消息；
   *   连不上 / 5 秒无响应都会给出可读原因（frp 没起、端口未放通、地址写错）。
   */
  Net.probeBroker = function (url, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const started = Date.now();
      let done = false;
      let client = null;
      let timer = null;
      const finish = (ok, error) => {
        if (done) return;
        done = true;
        if (timer) { try { clearTimeout(timer); } catch (e) {} }
        try { if (client) client.close(); } catch (e) {}
        resolve({ ok: !!ok, ms: Date.now() - started, error: error || '', url: url });
      };
      if (!url) { finish(false, 'empty'); return; }
      try {
        client = new Net.MqttClient({
          url: url,
          clientId: 'sgs_probe_' + Math.random().toString(36).slice(2, 8),
          username: opts.username || '', password: opts.password || '',
          reconnectPeriod: 0, keepalive: 0,
          WebSocketImpl: opts.WebSocketImpl ||
            (typeof WebSocket !== 'undefined' ? WebSocket : null),
          onState: (s, x) => {
            if (s === 'connected') finish(true);
            else if (s === 'error') finish(false, (x && (x.reason || x.code)) || 'socket');
          }
        });
        client.connect();
      } catch (e) {
        finish(false, (e && e.message) || 'exception');
        return;
      }
      timer = setTimeout(() => finish(false, 'timeout'), opts.timeout || 5000);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  };

  /* ================= 决策路由 ================= */
  // waitXxx 的「决策者」参数下标。绝大多数是第 0 个，少数第一个是 game。
  const WAIT_INDEX = {
    waitPlay: 0, waitRespond: 0, waitDiscard: 0, waitPick: 0, waitBrink: 0,
    waitTarget: 0, waitTargets: 0, waitWugu: 1, waitPeekHand: 0,
    waitChainTargets: 0, waitChoice: 0, waitTrickCard: 1,
    // ★【称象】亮牌多选：签名 (game, player, cards, opts) → 决策者是第 1 个参数。
    //   不加这条时远端玩家的称象会弹在主机屏幕上（主机替他选），客机永远等不到。
    waitReveal: 1,
    waitOptional: 0, waitWuXie: 0
  };
  Net.WAIT_INDEX = WAIT_INDEX;

  /**
   * ★ 要同步给客机的「表现层」方法。刻意用白名单而不是全量转发：
   *   render / refreshActions / setHint / log 已由快照与日志帧驱动；
   *   showStartScreen / bindGame 等启动方法绝不能在客机 battle 里重放。
   *   animateDraw 单独处理（对手摸牌必须显示牌背，不能外泄牌面）。
   */
  const FX_METHODS = [
    'skillFX', 'playDeathVoice',
    'showTableCard', 'showDeathDiscard', 'showJudgeCard', 'markJudgeResult',
    'clearTableCard', 'flyCard', 'flyCards', 'animateDraw',
    'showTargetLine', 'showTargetLines', 'showHitFX', 'shakeHero',
    'openWugu', 'setWuguTurn', 'markWuguTaken', 'closeWuguPanel',
    // ★【称象】的公开亮牌：效果是「亮出牌堆顶的牌」，两端都要看到同一批牌
    'showRevealPublic', 'markRevealTaken', 'closeRevealPanel',
    'closePeekPanel', 'closeTargetPanel'
  ];
  Net.FX_METHODS = FX_METHODS;

  /**
   * ★ 表现层广播器（1v1 / 2v2 共用）。
   *   先推一份同事务快照，再对**每个远端座位**单独判定能否看正面并各发一份
   *   fx。座位号是全局唯一的，因此这套判断与视角、人数、谁是房主都无关。
   *
   *   要求 session 提供：pushSnapshot(immediate) / recipientSeats() /
   *   send(frame)（frame.to = 收件座位）。1v1 与 2v2 都是这个形状。
   */
  Net.makeBroadcast = function (session) {
    return function (name, args) {
      const safe = args.slice();
      // animateDraw 的第 3 个参数是 Game，其余表现事件的第 3 个是 opts
      const opts = (name !== 'animateDraw' && safe[2] &&
        typeof safe[2] === 'object' && !Array.isArray(safe[2])) ? safe[2] : {};
      const game = session.game;
      const seats = P.fxFaceSeats(name, safe, {
        localSeat: game && game.human ? game.human.seat : null,
        remoteSeats: session.recipientSeats()
      });
      const toHand = name === 'animateDraw' ||
        opts.dest === 'hand' || opts.dest === 'ai-hero';
      const tx = ++session._tx;
      session.pushSnapshot(true);
      session.recipientSeats().forEach((seat) => {
        const seeFace = P.canSeeFxFace(seat, seats.providerSeat,
          seats.receiverSeat, seats.publicFace);
        const hide = toHand ? !seeFace
          : (!!opts.faceDown && !(seats.providerSeat != null &&
              String(seats.providerSeat) === String(seat)));
        const out = safe.slice();
        if (hide && out[0]) out[0] = P.hideCardFaces(out[0]);
        session.send({ t: 'fx', tx: tx, m: name, hide: !!hide,
          recv: seats.receiverSeat, src: seats.providerSeat, to: seat,
          pub: seats.publicFace ? 1 : 0,
          a: P.packFxArgs(out, game, seat) });
      });
    };
  };

  class RouterUI {
    constructor(localUI, remoteUI, broadcast) {
      this.localUI = localUI;
      this.remoteUI = remoteUI;
      const self = this;
      const proto = (SGS.UI && SGS.UI.prototype) || {};
      Object.getOwnPropertyNames(proto).forEach((name) => {
        if (name === 'constructor' || WAIT_INDEX[name] != null) return;
        if (typeof proto[name] !== 'function') return;
        self[name] = function () {
          const fn = localUI[name];
          const r = typeof fn === 'function' ? fn.apply(localUI, arguments) : undefined;
          // ★ 主机播完自己的动画后，把同一次调用转发给客机重放
          if (broadcast && FX_METHODS.indexOf(name) >= 0) {
            try { broadcast(name, Array.prototype.slice.call(arguments)); } catch (e) {}
          }
          return r;
        };
      });
      Object.keys(WAIT_INDEX).forEach((name) => {
        const idx = WAIT_INDEX[name];
        self[name] = function () {
          const decider = arguments[idx];
          const ui = (decider && decider.isRemote) ? remoteUI : localUI;
          return ui[name].apply(ui, arguments);
        };
      });
    }
    // 属性代理：protocol / 规则层会读 game.ui.wuguSession / pending
    get wuguSession() { return this.localUI.wuguSession; }
    set wuguSession(v) { this.localUI.wuguSession = v; }
    get pending() { return this.localUI.pending; }
    set pending(v) { this.localUI.pending = v; }
    get game() { return this.localUI.game; }
    set game(v) { this.localUI.game = v; }
  }
  Net.RouterUI = RouterUI;

  /* ================= 主机侧：远端玩家的 UI 代理 ================= */
  /**
   * ★ ask 的重传 / 兜底：MQTT 中继是「至多一次」，丢一帧就会让整桌人僵在
   *   「等待 XX 操作」上（五谷丰登选不了牌、称象问不出来都是这个形态）。
   *   做法：未收到 act 就按固定间隔重发同一帧（客机按 id 去重，不会重复执行）；
   *   超过上限仍无响应则按「放弃 / 默认项」结算，宁可少一次收益，也不锁死对局。
   *   两个常量可被自测覆盖成很小的值。
   */
  const ASK_RETRY_MS = 5000;
  const ASK_MAX_TRIES = 4;
  Net.ASK_RETRY_MS = ASK_RETRY_MS;
  Net.ASK_MAX_TRIES = ASK_MAX_TRIES;

  class RemoteUI {
    constructor(session) {
      this.session = session;
      this.seq = 0;
      this.waiters = {};
      const self = this;
      // 非 wait 方法兜底转发（规则层万一调用展示方法也不抛）
      const proto = (SGS.UI && SGS.UI.prototype) || {};
      Object.getOwnPropertyNames(proto).forEach((name) => {
        if (name === 'constructor' || WAIT_INDEX[name] != null || self[name]) return;
        if (typeof proto[name] !== 'function') return;
        self[name] = function () {
          const ui = self.session.ui;
          const fn = ui && ui[name];
          return typeof fn === 'function' ? fn.apply(ui, arguments) : undefined;
        };
      });
      Object.keys(WAIT_INDEX).forEach((name) => {
        self[name] = function () { return self.ask(name, arguments); };
      });
    }
    attach(session, game, remoteSeat) {
      this.session = session; this.game = game; this.remoteSeat = remoteSeat;
    }
    /** 先推一次权威快照，再发 ask —— 客机的手牌/按钮状态永远是最新的 */
    ask(method, args) {
      const self = this;
      return new Promise((resolve) => {
        const id = ++self.seq;
        const frame = {
          t: 'ask', id: id, method: method, to: self.remoteSeat,
          args: P.packArgs(Array.prototype.slice.call(args), self.game, self.remoteSeat)
        };
        const rec = { id: id, resolve: resolve, timer: null, tries: 0 };
        self.waiters[id] = rec;
        if (self.session.pushSnapshot) self.session.pushSnapshot(true);
        self.session.send(frame);
        const retry = Math.max(0, Number(Net.ASK_RETRY_MS) || 0);
        const maxTries = Math.max(1, Number(Net.ASK_MAX_TRIES) || 1);
        if (!retry) return;
        const tick = () => {
          if (self.waiters[id] !== rec) return;      // 已收到 act
          rec.tries++;
          if (rec.tries > maxTries) {
            delete self.waiters[id];
            // ★ 主机放弃这一问：必须显式告诉客机把界面收掉。
            //   否则客机那条 pending 永远停在原地，后面所有 ask 都排在它
            //   后面，表现就是「主机靠超时自己往下走了，客机整局卡死」。
            try {
              self.session.send({ t: 'askAbort', id: id, to: self.remoteSeat });
            } catch (e) {}
            // 兜底：按「不发动 / 不出牌 / 不选」结算，避免整桌卡死
            try {
              if (SGS.log) {
                SGS.log('远端玩家（座位 ' + self.remoteSeat + '）超时未响应【' +
                  method + '】，按放弃处理。', 'warn');
              }
            } catch (e) {}
            resolve(fallbackAct(method, args));
            return;
          }
          try { self.session.send(frame); } catch (e) {}
          rec.timer = setTimeout(tick, retry);
        };
        rec.timer = setTimeout(tick, retry);
      });
    }
    onAct(id, value) {
      const rec = this.waiters[id];
      if (!rec) return;
      delete this.waiters[id];
      if (rec.timer) clearTimeout(rec.timer);
      const fn = rec.resolve || rec;
      if (typeof fn === 'function') fn(P.unpackAct(value, this.game));
    }
  }
  Net.RemoteUI = RemoteUI;

  /**
   * 超时兜底值：尽量贴近「玩家什么都没做」时规则层能接受的形状。
   *   waitPlay    → 结束出牌
   *   waitDiscard → 空数组（规则层会再兜一层）
   *   waitTargets / waitChainTargets → 空数组
   *   其余（询问是否发动 / 打出 / 选牌）→ null = 放弃
   */
  function fallbackAct(method, args) {
    if (method === 'waitPlay') return { type: 'end' };
    if (method === 'waitDiscard' || method === 'waitTargets' ||
        method === 'waitChainTargets' || method === 'waitReveal') return [];
    if (method === 'waitWugu') return null;
    return null;
  }
  Net.fallbackAct = fallbackAct;

  /* ================= 会话基类 ================= */
  class Session {
    constructor(opts) {
      opts = opts || {};
      this.ui = opts.ui;
      this.role = opts.role === 'host' ? 'host' : 'guest';
      this.cfg = opts.cfg || Config.load();
      this.room = opts.room || '';
      this.onState = opts.onState || function () {};
      this.onLink = opts.onLink || function () {};
      this.myCharId = null;
      this.remoteCharId = null;
      this.game = null;
      this.started = false;
      this._snapTimer = null;
      this._frameQueue = [];
      // ★ fx / snap 同事务序号：主机广播一次表现就递增 _tx，并把带同一 tx
      //   的快照先于 fx 发出；客机按 _appliedTx 缓存并按序重放，避免快照
      //   重建 DOM 打断正在播放的动画。
      this._tx = 0;
      this._fxQueue = [];
      this._appliedTx = 0;
      this._lastSnap = null;
      // ★ 公网中继兜底：WebRTC 打洞失败（ICE failed / 迟迟不 open）时，
      //   游戏帧改由「做信令的同一台 broker」转发，地址不需要再配。
      this._relayMode = false;
      this._relayTimer = null;
      this._closed = false;
      // ★ 心跳：DataChannel 会出现「一端 ready 但数据发不出去」的半死状态
      //   （校园网 / NAT 会话超时很常见）。只靠 ready 判断会两边僵住：
      //   一方显示已连接、另一方显示数据通道断开，谁也开不了局。
      this._lastRx = 0;
      this._hbTimer = null;
      const self = this;

      this.sig = new Net.Signaling({
        brokerUrl: this.cfg.brokerUrl, appId: this.cfg.appId, room: this.room,
        role: this.role, username: this.cfg.username, password: this.cfg.password,
        WebSocketImpl: opts.WebSocketImpl,
        helloExtra: opts.helloExtra || null,
        onState: (s, x) => self.onState('signal:' + s, x),
        onPresence: (m) => self.onState('presence', m),
        onSignal: (type, data) => self.onSignal(type, data),
        onRelay: (frame) => self.onRelayFrame(frame)
      });
      this.sid = this.sig.sid;
      this.transport = new Net.Transport({
        role: this.role, sid: this.sid,
        iceServers: Net.defaultIceServers(),
        RTCPeerConnectionImpl: opts.RTCPeerConnectionImpl,
        onSignal: (type, data) => self.sig.sendSignal(type, data),
        onOpen: () => {
          self._clearRelayTimer();
          if (self._relayMode) return;      // 已经走中继，就不再切回去
          self._lastRx = Date.now();
          self.onState('channel:open');
          self.flushFrames();
        },
        onClose: (why) => {
          // ★ 已经切到中继 / 主动关闭：不要再用「断开」把中继状态覆盖掉
          //   （之前的现象：主机其实已经在中继上，界面却停在红色「数据通道断开」）
          if (self._closed || self._relayMode) return;
          self.onState('channel:close', { why: why });
          // ★ 直连断了 / 从来没连通 → 改用公网中继，对局不中断
          self.useRelay(why);
        },
        onMessage: (m) => {
          if (m && (m.t === 'ping' || m.t === 'pong')) { self._onHeartbeat(m); return; }
          self.onFrame(m);
        },
        // ★ 两端各自 getStats() 的 local candidate 是镜像的，直接各显示各的
        //   会出现「两端判定不一致」。统一由主机测一次，
        //   再随帧下发给客机，两边永远显示同一条链路结论。
        onLink: (info) => {
          if (self.role === 'host') {
            self.onLink(info);
            self.send({ t: 'link', info: info });
          }
        }
      });
      // 主机固定 offerer —— 1v1 无 glare
      if (this.role === 'host') {
        // 等客机 hello 后再发 offer，避免客机还没订阅就发
        this._offerPending = true;
      }
    }

    start() {
      // announce / hello 由 Signaling 在每次 CONNACK 后驱动（含重连），
      // 这里不再同步发，避免 ws 还在 CONNECTING 时丢包。
      this.sig.start();
      this._startHeartbeat();
      return this;
    }

    /* ---------------- 心跳：识别「ready 但发不出去」的半死通道 ---------------- */

    _startHeartbeat() {
      if (this._hbTimer || typeof setInterval !== 'function') return;
      const t = setInterval(() => this._hbTick(), 4000);
      if (t && typeof t.unref === 'function') t.unref();
      this._hbTimer = t;
    }
    _stopHeartbeat() {
      if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    }
    _hbTick() {
      if (this._closed) return;
      if (this._relayMode) return;                       // 中继自带 broker 保活
      if (!this.transport || !this.transport.ready) return;
      // 收到过东西之后才开始计时判定，避免刚 open 就误判
      // 15s 收不到任何心跳 / 游戏帧才判定通道已死：给后台标签页的
      // 定时器节流（可能被压到 1 次/分钟）留足余量，避免误切。
      if (this._lastRx && Date.now() - this._lastRx > 15000) {
        this.useRelay('stale');
        return;
      }
      // 直接从 transport 发，不走 this.send 的排队逻辑
      try { this.transport.send({ t: 'ping', ts: Date.now() }); } catch (e) {}
    }
    _onHeartbeat(m) {
      this._lastRx = Date.now();
      if (m.t === 'ping' && !this._relayMode && this.transport && this.transport.ready) {
        try { this.transport.send({ t: 'pong', ts: m.ts }); } catch (e) {}
      }
    }

    /**
     * ★ 等 P2P 的时间上限：收到 hello / offer 之后开始计时。
     *   到点还没 open（或中途 failed）就走公网中继 —— 不能让玩家一直卡在
     *   「对手已加入，正在建连…」上，尤其是手机热点 / 公司网这类打洞高发失败环境。
     */
    _armRelayFallback(ms) {
      if (this._relayMode || this._relayTimer) return;
      const t = setTimeout(() => {
        this._relayTimer = null;
        if (this.transport && this.transport.ready) return;   // 已经直连上了
        this.useRelay('timeout');
      }, ms == null ? 8000 : ms);
      if (t && typeof t.unref === 'function') t.unref();       // 自测环境不阻塞退出
      this._relayTimer = t;
    }
    _clearRelayTimer() {
      if (this._relayTimer) { clearTimeout(this._relayTimer); this._relayTimer = null; }
    }

    /**
     * 切到公网中继：后续游戏帧一律经信令 broker 转发（服务器地址不变）。
     *
     * ★ 必须「主动告知对端」：只在本端切是不够的 —— 对端可能还停留在
     *   一条 ready 但已经发不出数据的直连上（校园网 NAT 会话超时的典型表现：
     *   一端显示已连接、另一端显示数据通道断开，双方互等、永远开不了局）。
     *   这里发一条 {t:'relay'} 控制帧，对端收到后立即跟着切。
     *   opts.silent = 对端告知触发的切换，不再回通知，避免两端乒乓。
     */
    useRelay(why, opts) {
      if (this._relayMode) return false;
      this._relayMode = true;
      this._clearRelayTimer();
      this._stopHeartbeat();
      try { this.transport.close(); } catch (e) { /* 已断开 */ }
      this.onState('channel:relay', { why: why || '' });
      if (!(opts && opts.silent)) {
        try { this.sig.sendRelay({ t: 'relay' }); } catch (e) {}
      }
      // 握手帧可能正好丢在那条死掉的直连上 → 切过来之后补发一次
      this._resyncAfterRelay();
      this.flushFrames();
      return true;
    }

    /** 收到对端经中继发来的帧：对端已经切了，本端跟着切，避免单向不通 */
    onRelayFrame(frame) {
      if (!frame || !frame.t) return;
      this._lastRx = Date.now();
      if (!this._relayMode) this.useRelay('peer', { silent: true });
      if (frame.t === 'relay') return;          // 只是切换通知，不喂给规则层
      this.onFrame(frame);
    }

    /**
     * 切到中继后重放「握手类」帧。
     *   · char：选将结果 —— 直连挂掉时这一帧最可能已经丢了，
     *     丢了主机就永远等不到对手武将，也就不会开始对局（本次的卡死根因）。
     *   · init + 快照：主机已经开局时，补一份完整状态给客机。
     */
    _resyncAfterRelay() {
      try {
        if (this.myCharId) {
          this.send({ t: 'char', charId: this.myCharId, role: this.role });
        }
        if (this.role !== 'host') return;
        if (this.game && typeof this.pushSnapshot === 'function') {
          // 已经开过局：把 init 与权威快照补发一遍
          if (typeof this.sendInit === 'function') this.sendInit();
          this.pushSnapshot(true);
        } else if (this.remoteCharId && typeof this.maybeBegin === 'function') {
          this.maybeBegin();
        }
      } catch (e) { /* 补发失败不影响后续帧 */ }
    }

    onSignal(type, data) {
      if (type === 'hello' && this.role === 'host') {
        this.onState('peer:joined');
        if (this._offerPending) {
          this._offerPending = false;
          this.transport.makeOffer().catch(() => {});
          // 对手已到：开始给 P2P 计时，超时就转公网中继
          this._armRelayFallback();
        }
        return;
      }
      if (type === 'offer') {
        this.transport.acceptOffer(data).catch(() => {});
        this._armRelayFallback();
        return;
      }
      if (type === 'answer') { this.transport.acceptAnswer(data).catch(() => {}); return; }
      if (type === 'candidate') { this.transport.addCandidate(data).catch(() => {}); return; }
    }

    /** DataChannel 未 open 时排队，绝不静默丢动作 */
    send(frame) {
      // ★ 中继模式：直接走信令 broker（地址与信令相同，不额外部署）
      if (this._relayMode) { this.sig.sendRelay(frame); return; }
      if (!this.transport.ready) { this._frameQueue.push(frame); return; }
      this.transport.send(frame);
    }
    flushFrames() {
      const list = this._frameQueue.splice(0);
      list.forEach((f) => this.send(f));
    }

    onFrame(m) {
      if (!m || !m.t) return;
      this._lastRx = Date.now();
      // ★ 2v2 房间控制帧（welcome / room / pool / start / kick）交给子类处理，
      //   不进入 1v1 的 switch；返回 true 表示已被消费。
      if (typeof this.onRoomFrame === 'function' && this.onRoomFrame(m)) return;
      switch (m.t) {
        case 'char': this.onChar(m); break;
        case 'init': this.onInit(m); break;
        case 'snap': this.onSnap(m); break;
        case 'ask': this.onAsk(m); break;
        case 'askAbort': this.onAskAbort(m); break;
        case 'act': this.onActFrame(m); break;
        case 'log': this.onLogFrame(m); break;
        case 'fx': this.onFxFrame(m); break;
        case 'link': if (this.role === 'guest') this.onLink(m.info); break;
        case 'over': this.onOver(m); break;
        default: break;
      }
    }
    onChar() {} onInit() {} onSnap() {} onAsk() {} onFxFrame() {}
    onActFrame() {} onOver() {} onAskAbort() {}
    onLogFrame(m) {
      try { if (this.ui && typeof this.ui.log === 'function') this.ui.log(m.m, m.c); }
      catch (e) {}
    }

    /** 选将完成：把角色发给对端；两边齐了才开局 */
    startGame(charId) {
      this.myCharId = charId;
      // ★ 联机在等对端选将 / 开局期间，沿用战斗界面氛围底图当等候界面，
      //   只把 #app 里写死的占位换成真实状态（自己选的将 / 对方隐藏 / 160 张）。
      if (NetUI && NetUI.showWait) {
        try { NetUI.showWait(this.ui, charId, this.role, this.room); } catch (e) {}
      }
      this.send({ t: 'char', charId: charId, role: this.role });
      if (this.role === 'host') this.maybeBegin();
      else this.onState('waiting-host');
    }
    maybeBegin() {}

    close() {
      this._closed = true;
      this._clearRelayTimer();
      this._stopHeartbeat();
      try { this.sig.close(); } catch (e) {}
      try { this.transport.close(); } catch (e) {}
      (this._fxQueue || []).forEach((r) => { if (r.timer) clearTimeout(r.timer); });
      this._fxQueue = [];
      this.ui.onRender = null; this.ui.onLog = null;
      if (NetUI) {
        NetUI.linkSuffix = '';
        if (NetUI.hideWait) { try { NetUI.hideWait(); } catch (e) {} }
      }
    }
  }
  Net.Session = Session;

  /* ================= 主机 ================= */
  class HostSession extends Session {
    constructor(opts) {
      super(Object.assign({ role: 'host' }, opts));
      this.remoteUI = new RemoteUI(this);
    }
    onChar(m) { this.remoteCharId = m.charId; this.maybeBegin(); }
    maybeBegin() {
      if (this.started || !this.myCharId || !this.remoteCharId) return;
      // ★ 数据面没通就等 —— 但「已切公网中继」也算通了：
      //   中继模式下 transport.ready 永远是 false，若还按它判就会永远 pending，
      //   表现就是「双方都显示已连接、却一直不开局」。
      if (!this.transport.ready && !this._relayMode) {
        this._beginPending = true;
        return;
      }
      this.begin();
    }
    flushFrames() {
      super.flushFrames();
      if (this._beginPending) { this._beginPending = false; this.maybeBegin(); }
    }
    /**
     * ★ 表现层广播器（1v1 / 2v2 共用）：
     *   先推一份同事务快照，再对**每个远端座位**单独判定能否看正面并各发一份
     *   fx。座位号是全局唯一的，因此这套判断与视角、人数、谁是房主都无关。
     */
    makeBroadcast() {
      return Net.makeBroadcast(this);
    }

    begin() {
      this.started = true;
      if (NetUI && NetUI.hideWait) { try { NetUI.hideWait(); } catch (e) {} }
      const ui = this.ui;
      const self0 = this;
      const router = new RouterUI(ui, this.remoteUI, this.makeBroadcast());
      const game = new SGS.Game(ui, this.myCharId, {
        mode: '1v1', remote: true, remoteCharId: this.remoteCharId,
        uiRouter: router
      });
      this.game = game;
      this.remoteSeat = game.aiPlayer.seat;
      game.vsAI = false;                 // 顶栏显示「对手回合」而非「AI 回合」
      this.remoteUI.attach(this, game, this.remoteSeat);
      ui.bindGame(game);
      ui.vsAI = false;
      // ★ 联机标识（主机侧）：顶栏的「AI 托管」只适用于单机，联机里一律隐藏
      //   —— 主机的操作要和客机对称，不能让本地 AI 替真人把回合打完。
      ui._netHost = true;
      const self = this;
      // ★ 每次状态渲染都推一次按座位裁剪的快照（合并 24ms 内的连续 render）
      ui.onRender = () => self.pushSnapshot();
      ui.onLog = (m, c) => self.send({ t: 'log', m: m, c: c });
      // ★ 战斗 BGM：主机在真正建好对局（begin）时启动，而不是选将 / 建房时。
      //   若浏览器拦截自动播放，Audio 层会在下一次点击时补播。
      try { if (SGS.Audio && SGS.Audio.startBgm) SGS.Audio.startBgm(); } catch (e) {}
      this.sendInit();
      this.pushSnapshot(true);
      this.onState('game:start');
      game.run().then(() => {
        const alive = (game.players || []).find((p) => !p.isDead());
        const hostWon = !!(alive && alive === game.human);
        self.send({ t: 'over', hostWon: hostWon });
      }).catch(() => {});
    }
    /** 把「对局初始化」帧补发一次（中继切换后重同步也用它） */
    sendInit() {
      if (!this.game) return;
      this.send({ t: 'init', seat: this.remoteSeat,
        hostCharId: this.myCharId, guestCharId: this.remoteCharId,
        hostSeat: this.game.human.seat });
    }
    /**
     * ★ 表现层帧的收件人座位列表。
     *   当前是「1 主机 + 1 客机」，只有一个远端座位；多人局把其余远端座位
     *   一并放进这个数组即可 —— 每个收件人的正反面由 P.canSeeFxFace 逐个
     *   判定、各自打包一份参数，不存在「一份 frame 群发导致串味」的问题。
     *   快照同理：pushSnapshot 也是按座位各生成、各下发一份。
     *   （前提：send 支持按座位定向发送。）
     */
    recipientSeats() {
      return this.remoteSeat != null ? [this.remoteSeat] : [];
    }
    pushSnapshot(immediate) {
      if (!this.game) return;
      const self = this;
      const emit = () => {
        self._snapTimer = null;
        // ★ 按座位各裁剪一份：客机只能看见自己该看见的那部分
        self.recipientSeats().forEach((seat) => {
          self.send({ t: 'snap', tx: self._tx, to: seat,
            snap: P.makeSnapshot(self.game, seat) });
        });
      };
      if (this._snapTimer) clearTimeout(this._snapTimer);
      // ★ 中继模式下每次 send 都是一次 MQTT 发布：把渲染驱动的快照合并得
      //   更粗（120ms），避免一次动画连发几十条把公共 broker 打到限流。
      //   fx 之前的「同事务快照」仍然是 immediate，不受影响。
      if (immediate) emit();
      else this._snapTimer = setTimeout(emit, this._relayMode ? 120 : 24);
    }
    onActFrame(m) { this.remoteUI.onAct(m.id, m.value); }
  }
  Net.HostSession = HostSession;

  /* ================= 客机 ================= */
  class GuestSession extends Session {
    constructor(opts) {
      super(Object.assign({ role: 'guest' }, opts));
      this.viewGame = P.makeViewGame(this.ui);
      this._askQueue = [];
      // ★ ask 串行：同一时刻只允许一个「等待玩家操作」的界面，
      //   后续 ask 排队处理；已答过的 id 记住答案，主机重传时直接补发。
      this._askOpen = null;
      this._askPending = [];
      this._answered = {};
      this._askWatch = null;
      // ★ 视图模式：UI 的所有 render（含 ask 触发的那些）都只做 keyed diff，
      //   不重建 #me-hand —— 这样飞牌替身 / FLIP 不会被半路打断。
      if (this.ui) this.ui._netView = true;
    }
    onInit(m) {
      if (NetUI && NetUI.hideWait) { try { NetUI.hideWait(); } catch (e) {} }
      this.mySeat = m.seat;
      NetUI.linkSuffix = NetUI.linkSuffix || '';
      this.hostCharId = m.hostCharId;
      this.viewGame.viewerSeat = m.seat;
      // 新的一局：上一局的 ask 记录（id 从 1 重新计数）必须清掉，否则会误判成重传
      this._askOpen = null;
      this._askPending = [];
      this._answered = {};
      this._askWatch = null;
      this.ui.bindGame(this.viewGame);
      this.ui.vsAI = false;
      // ★ 战斗 BGM：客机在收到 init（对局真正开始）时启动，
      //   选将 / 房间阶段保持安静；被浏览器拦截则由 Audio 层等下一次点击补播。
      try { if (SGS.Audio && SGS.Audio.startBgm) SGS.Audio.startBgm(); } catch (e) {}
      // 收到 init 时可能已有排队的快照/ask，按序补放
      const q = this._askQueue.splice(0);
      q.forEach((frame) => this.onFrame(frame));
      this.onState('game:init');
    }
    onSnap(m) {
      if (!this.mySeat && !(m.snap && m.snap.viewerSeat)) return;
      const seat = this.mySeat || m.snap.viewerSeat;
      const prev = this._lastSnap;
      P.applySnapshot(this.viewGame, m.snap);
      this.viewGame.viewerSeat = seat;
      // ★ 差量渲染：按牌 id 复用未变化的 DOM 节点，只更新真正变了的区域，
      //   避免每次快照都整块重建 #me-hand 导致 CSS 过渡 / 飞牌被打断。
      try {
        if (typeof this.ui.renderPatch === 'function' && typeof document !== 'undefined' &&
            typeof document.querySelectorAll === 'function') {
          this.ui.renderPatch(this.viewGame, prev, m.snap);
        } else this.ui.render(this.viewGame);
      } catch (e) {
        try { this.ui.render(this.viewGame); } catch (e2) {}
      }
      this._lastSnap = m.snap;
      // ★ 先应用快照再放行同事务 fx：动画基于最新视图状态计算落点。
      this._appliedTx = Math.max(this._appliedTx, m.tx || 0);
      this._drainFx();
      // ★ 五谷面板由快照驱动：主机 openWugu → 客机建 session；
      //   主机 closeWuguPanel → wugu 变 null → 客机自动收起（修「不自动关」）。
      if (m.snap.wugu) {
        if (!this.ui.wuguSession && typeof this.ui.openWugu === 'function') {
          try { this.ui.openWugu(this.viewGame, m.snap.wugu.cards.slice()); } catch (e) {}
        }
        if (this.ui.wuguSession && typeof this.ui.renderWuguPanel === 'function') {
          try { this.ui.renderWuguPanel(); } catch (e) {}
        }
      } else if (this.ui.wuguSession && typeof this.ui.closeWuguPanel === 'function') {
        try { this.ui.closeWuguPanel(); } catch (e) {}
      }
    }
    onFxFrame(m) {
      // init 之前的表现事件先排队，viewGame 建好后按序补放
      if (!this.mySeat) { this._askQueue.push(m); return; }
      // ★ 同事务排序：快照还没到的 fx 先缓存；120ms 兜底强制播放，
      //   避免主机某次表现没有伴随 render 时永久挂起。
      if (m.tx && m.tx > this._appliedTx) {
        const rec = { m: m, timer: null };
        rec.timer = setTimeout(() => {
          const i = this._fxQueue.indexOf(rec);
          if (i >= 0) { this._fxQueue.splice(i, 1); this.replayFx(m); }
        }, 120);
        this._fxQueue.push(rec);
        return;
      }
      this.replayFx(m);
    }
    /** 快照应用后，放行所有 tx 已就绪的 fx（保持原来的先后顺序） */
    _drainFx() {
      if (!this._fxQueue.length) return;
      const ready = this._fxQueue.filter((r) => !(r.m.tx > this._appliedTx));
      if (!ready.length) return;
      this._fxQueue = this._fxQueue.filter((r) => ready.indexOf(r) < 0);
      ready.forEach((r) => {
        if (r.timer) clearTimeout(r.timer);
        this.replayFx(r.m);
      });
    }
    replayFx(m) {
      const vg = this.viewGame;
      // ★★ 正反面的绝对判据：座位号直接比（P.canSeeFxFace）。
      //   只有「牌的提供者」和「获得者」看正面，其他人一律牌背。
      //   绝不再用「谁是 vg.human / aiPlayer」去猜 —— 那只在 1v1 成立，
      //   多人局里第三、第四个玩家会被判错（白看牌面 / 自己拿的牌却显示牌背）。
      //   老主机不带 src/recv 时才回退到按角色对象比对（兼容旧房间）。
      const selfPlayer = vg && vg.human;
      const isMine = (p) => {
        if (!p || p.seat == null || !vg) return false;
        const all = vg.players || [];
        const match = all.find((x) => String(x.seat) === String(p.seat));
        const who = match || p;             // 与场上所有角色比对
        return !!selfPlayer && (who === selfPlayer ||
          String(who.seat) === String(selfPlayer.seat) ||
          String(who.seat) === String(vg.viewerSeat));
      };
      // 座位号齐备 → 绝对判定；否则 null（调用方回退到旧比对方式）
      // publicFace = 这张牌全场公开（五谷亮牌 / 装备区·判定区明牌）→ 人人正面
      const seatSays = (srcSeat, recvSeat, publicFace) =>
        (srcSeat == null && recvSeat == null)
          ? (publicFace ? true : null)
          : P.canSeeFxFace(this.mySeat, srcSeat, recvSeat, publicFace);
      // 我是不是获得者（决定落点：飞进我的手牌区 / 飞向别人的区域）
      const seatIsMe = (s) => s != null && this.mySeat != null &&
        String(s) === String(this.mySeat);
      let args;
      try { args = P.unpackFxArgs(m.a, vg, this.mySeat, m.hide); }
      catch (e) {
        // 不再让异常被 transport 静默吞掉：至少留一条可查的告警
        if (typeof console !== 'undefined' && console.warn) {
          try { console.warn('[net] fx 解包失败：' + m.m, e); } catch (e2) {}
        }
        return;
      }
      const ui = this.ui;

      // ★ 摸牌：收牌人 = 自己 → 真牌面正面飞进手牌区；否则牌背飞向对手框。
      //   不用 ui.animateDraw，避免 flipInsertIntoHand 在客机改视图状态。
      //   ★ from:'table' 必须带：flyCard 默认按 fromPlayer.isHuman 取起点，
      //     客机视角下会变成「从手牌区/角色框飞到同一区域」，几乎原地不动，
      //     看起来就是摸牌没动画。显式指定从中央牌堆起飞才与主机一致。
      if (m.m === 'animateDraw') {
        const cards = args[0] || [], player = args[1];
        // ★ 两个判据取「或」：帧上的 recv 是最权威的，视图 player 兜住旧主机
        //   不带 recv / init 尚未拿到 mySeat 的窗口。任一成立都算「自己摸牌」，
        //   否则自家摸牌会被误判成别人摸牌 → dest='ai-hero' → 跳过插入手牌
        //   动画（表现就是「自己摸牌直接出现在手里，没有飞牌」）。
        const mine = seatIsMe(m.recv) || isMine(player);
        const seatSee = seatSays(null, m.recv, false);
        // 摸牌没有提供者：只有获得者能看正面
        const face = (seatSee == null ? mine : seatSee) && !m.hide;
        cards.forEach((c, i) => {
          // ★ 多张按 1/3 卡宽错位、逐张错峰起飞，与主机 animateDrawToAI
          //   的「露出 1 / 盖住 2」叠放观感一致，不再几张完全重叠。
          // ★ toPlayer 必须带上：dest='ai-hero' 的落点靠 heroEl(toPlayer) 取框。
          //   少了它，2v2 里所有人摸牌都会飞向「屏幕最上方那张角色框」——
          //   那是 1v1 时代 destEl 的回退值（$('ai-area')），四人局里全错。
          try { ui.flyCard(c, player, { from: 'table',
            dest: mine ? 'hand' : 'ai-hero', toPlayer: player,
            faceDown: !face,
            stackIndex: i, stackCount: cards.length, delay: i * 110 }); } catch (e) {
            if (typeof console !== 'undefined' && console.warn) {
              try { console.warn('[net] 摸牌飞牌失败', e); } catch (e2) {}
            }
          }
        });
        return;
      }

      // ★ 获得牌（顺手牵羊 / 借刀杀人 / 五谷选牌落入手牌…）：
      //   落点看「我是不是获得者」，正反面看「提供者/获得者是否是我」，
      //   两者分开判 —— 被牵的一方是提供者：牌飞向别人，但自己看正面。
      if ((m.m === 'flyCard' || m.m === 'flyCards') && args[2] &&
          (args[2].dest === 'hand' || args[2].dest === 'ai-hero')) {
        const o = args[2];
        // ★ 同样取「或」：帧上的 recv 优先，视图里的获得者兜底
        const mine = seatIsMe(m.recv) || isMine(o.toPlayer);
        // ★ 全场公开的牌（五谷亮牌 / 装备区·判定区明牌）→ 谁都能看正面。
        //   优先读帧上的 pub（主机已按区域 faceUp 判好），再退回参数里的 public。
        const isPub = m.pub != null ? !!m.pub : !!o.public;
        const seatSee = seatSays(m.src, m.recv, isPub);
        const face = (seatSee == null
          ? (mine || isMine(args[1])) : seatSee) && !m.hide;
        o.dest = mine ? 'hand' : 'ai-hero';
        o.faceDown = !face;
        o.onArrive = null;               // 客机状态只由权威快照决定
      }
      // ★ 装备落点是「我方装备栏」，若装装备的是对手（客机视角），
      //   改成飞向对手角色框，避免飞到客机自己的装备区。
      if (m.m === 'flyCard' && args[2] && args[2].dest === 'equip' &&
          args[1] && !args[1].isHuman) {
        args[2] = Object.assign({}, args[2], { dest: 'ai-hero', faceDown: false });
      }

      // ★ 视角还原「离手」起点：主机把客机的牌当 AI 手牌（from:'hero'，
      //   起点画在角色框）。客机看得见自己的手牌，快照里还在的多张牌应改回
      //   从手牌区那张真卡起飞，并与主机玩家一样让手牌区同步合拢。
      if ((m.m === 'flyCard' || m.m === 'flyCards') && args[2] &&
          isMine(args[1]) && args[2].from === 'hero' && vg && vg.human) {
        const cards0 = m.m === 'flyCards' ? (args[0] || []) : [args[0]];
        const cardIds = cards0.map((c) => c && c.id != null ? String(c.id) : '');
        const handIds = (vg.human.hand || []).map((c) => String(c.id));
        if (cardIds.length && cardIds.every((id) => handIds.indexOf(id) >= 0)) {
          args[2] = Object.assign({}, args[2]);
          delete args[2].from;
        }
      }
      // ★ 批量弃牌：主机在玩家侧走 showTableCardsBatch（每张各有落点、同时
      //   起飞同时落地）。客机视角那位玩家是 aiPlayer，必须显式带 batch，
      //   否则逐张飞全部落到展示区中央，看起来就是「叠在一起」。
      if (m.m === 'flyCards' && args[2] &&
          (args[2].dest || 'showcase') === 'showcase' &&
          (args[0] || []).length > 1 && !args[2].from && !args[2].faceDown) {
        args[2] = Object.assign({}, args[2], { batch: true });
      }
      const fn = ui && ui[m.m];
      if (typeof fn !== 'function') return;
      try {
        const r = fn.apply(ui, args);
        // ★ 表现层方法多半是 async（flyCard / flipInsertIntoHand / animateDraw…）。
        //   这里不 await（动画不能阻塞收帧），但必须接住 rejection：
        //   否则方法内部一个 TypeError 就会变成「什么都没发生」的哑失败 ——
        //   之前客机得牌没有飞牌动画，就是 dataset 赋值抛错被这样吞掉的。
        if (r && typeof r.then === 'function' && typeof r.catch === 'function') {
          r.catch((e) => {
            if (typeof console !== 'undefined' && console.warn) {
              try { console.warn('[net] fx 动画异常：' + m.m, e); } catch (e2) {}
            }
          });
        }
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) {
          try { console.warn('[net] fx 重放失败：' + m.m, e); } catch (e2) {}
        }
      }
    }
    onAsk(m) {
      // init 之前的 ask 先排队，避免 viewGame 还没建好
      if (!this.mySeat) { this._askQueue.push(m); return; }
      if (!m || m.id == null) return;
      // ★ 主机重传同一条 ask：已经答过就原样重发答案，不再弹一次界面
      if (this._answered &&
          Object.prototype.hasOwnProperty.call(this._answered, m.id)) {
        this.send({ t: 'act', id: m.id, value: this._answered[m.id] });
        return;
      }
      // 正在等这个 id 的答案（重复帧）→ 忽略
      if (this._askOpen && this._askOpen.id === m.id) return;
      // ★ 上一条 ask 的界面已经不存在了（面板被 fx / 快照收起、pending 被
      //   覆盖）：视为那一问已作废，直接释放单槽，别让它永久堵住队列。
      if (this._askOpen && (!this.ui || !this.ui.pending)) {
        this._clearAskWatch();
        this._askOpen = null;
      }
      // ★ 上一条 ask 还没答完：排队，绝不能直接覆盖 —— 直接覆盖会让前一个
      //   Promise 永远悬着，主机一直等那一步，表现就是「全员卡死」。
      if (this._askOpen) { this._askPending.push(m); return; }
      this._runAsk(m);
    }

    /** 主机已放弃某一问（超时）：收起客机界面并放行队列，绝不回 act */
    onAskAbort(m) {
      if (!m) return;
      const id = m.id;
      if (this._askPending && this._askPending.length) {
        this._askPending = this._askPending.filter((f) => f.id !== id);
      }
      if (!this._askOpen) return;
      if (id != null && this._askOpen.id !== id) return;
      this._clearAskWatch();
      this._askOpen = null;
      if (SGS.log) SGS.log('主机已放弃这一问，界面自动收起。', 'warn');
      try {
        if (this.ui && typeof this.ui.cancelPending === 'function') {
          this.ui.cancelPending();
        } else if (this.ui) {
          this.ui.pending = null;
          if (this.ui.refreshActions) this.ui.refreshActions();
        }
      } catch (e) { /* 界面收起失败也不能堵住队列 */ }
      const next = this._askPending.shift();
      if (next) this._runAsk(next);
    }

    _clearAskWatch() {
      if (this._askWatch) {
        try { clearTimeout(this._askWatch); } catch (e) {}
        this._askWatch = null;
      }
    }

    /** 真正把一条 ask 交给本地 UI，并接管它的 resolve（答完立刻上送） */
    _runAsk(m) {
      const self = this;
      const ui = this.ui;
      const fn = ui && ui[m.method];
      this._askOpen = { id: m.id, method: m.method };
      // ★ 看门狗：askAbort 帧本身也可能在公共 broker 上丢掉。若这一问
      //   超过「主机重试上限 × 2」还没有结果，客机自己也把界面收掉，
      //   否则后面每一条 ask 都会永久排队（超时兜底只救了主机）。
      const retry = Math.max(0, Number(Net.ASK_RETRY_MS) || 0);
      const maxTries = Math.max(1, Number(Net.ASK_MAX_TRIES) || 1);
      const limit = retry ? Math.max(30000, retry * maxTries * 2) : 0;
      this._clearAskWatch();
      if (limit) {
        this._askWatch = setTimeout(() => {
          if (!self._askOpen || self._askOpen.id !== m.id) return;
          self._askWatch = null;
          self._askOpen = null;
          try {
            if (self.ui && typeof self.ui.cancelPending === 'function') {
              self.ui.cancelPending();
            } else if (self.ui) {
              self.ui.pending = null;
            }
          } catch (e) {}
          if (SGS.log) SGS.log('这一问长时间没有结果，已自动收起。', 'warn');
          const next = self._askPending.shift();
          if (next) self._runAsk(next);
        }, limit);
        // Node 自测里别让这个定时器拖住进程
        if (this._askWatch && typeof this._askWatch.unref === 'function') {
          this._askWatch.unref();
        }
      }
      const finishAsk = (value) => {
        if (!self._askOpen || self._askOpen.id !== m.id) return;
        self._askOpen = null;
        self._clearAskWatch();
        const packed = P.packAct(value);
        if (!self._answered) self._answered = {};
        self._answered[m.id] = packed;
        const keys = Object.keys(self._answered);
        if (keys.length > 40) {
          keys.slice(0, keys.length - 40).forEach((k) => { delete self._answered[k]; });
        }
        self.send({ t: 'act', id: m.id, value: packed });
        const next = self._askPending.shift();
        if (next) self._runAsk(next);
      };
      if (typeof fn !== 'function') { finishAsk(null); return; }
      let args;
      try { args = P.unpackArgs(m.args, this.viewGame); }
      catch (e) { finishAsk(null); return; }
      try { fn.apply(ui, args); }
      catch (e) {
        if (typeof console !== 'undefined' && console.warn) {
          try { console.warn('[net] ask 界面异常：' + m.method, e); } catch (e2) {}
        }
        finishAsk(null);
        return;
      }
      const pd = ui.pending;
      if (!pd || typeof pd.resolve !== 'function') {
        // 界面没留住 pending（例如本端暂时无法操作）→ 立刻按放弃回传，
        // 让主机继续往下走，而不是干等一个永远不会有结果的询问。
        finishAsk(null);
        return;
      }
      const orig = pd.resolve;
      pd.resolve = (v) => { orig(v); finishAsk(v); };
    }
    onOver(m) {
      // ★ 2v2 是「阵营胜」，不能再用「房主是否获胜」反推 —— 主机直接下发 win。
      const win = (m && m.win != null) ? !!m.win : !(m && m.hostWon);
      try { this.ui.showGameOver(win, this.viewGame); } catch (e) {}
      this.onState('game:over');
    }
  }
  Net.GuestSession = GuestSession;

  /* ================= 联机面板（动态挂载进选将层） ================= */
  const LABEL = {
    'signal:connecting': '正在连接信令…', 'signal:connected': '信令已连接',
    'signal:disconnected': '信令断开，正在重连…', 'signal:error': '信令连接失败',
    'peer:joined': '对手已加入，正在建连…', 'channel:open': '已连接，等待开局',
    // ★ 不提示「走的是哪种联机方式」：打洞失败自动转公网中继，玩家只需要知道连上了
    'channel:relay': '已连接',
    'channel:close': '数据通道断开', 'presence': '房间状态更新',
    'waiting-host': '已选将，等待房主开局…', 'game:init': '对局已同步',
    'game:start': '对局开始', 'game:over': '对局结束'
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /**
   * ★ 4 位纯数字房间码：好念、好输入（口头/微信传达都方便）。
   *   取 1000–9999 避免前导零被吞；理论上只有 9000 种，公共服务器上
   *   撞车概率极低，但并非为零 —— 真撞上了换个码即可（房主可自填）。
   */
  function randomRoom() {
    return String(1000 + Math.floor(Math.random() * 9000));
  }
  Net.randomRoom = randomRoom;

  const NetUI = Net.UI = {
    /** 当前模式（1v1 / 2v2）：联机入口按模式分开显示，互不干扰 */
    mode: '1v1',
    /** 切换联机面板的模式（由选将界面在进入时调用） */
    setMode(mode) {
      this.mode = (mode === '2v2') ? '2v2' : '1v1';
      const doc = global.document;
      if (!doc || !doc.getElementById) return;
      const bar = doc.getElementById('net-bar');
      if (bar && bar.classList) {
        bar.classList.toggle('mode-1v1', this.mode === '1v1');
        bar.classList.toggle('mode-2v2', this.mode === '2v2');
      }
      const toggle = doc.getElementById('net-toggle');
      if (toggle) {
        const tip = this.mode === '2v2'
          ? '联机组队 <em>▼</em>' : '联机单挑 <em>▼</em>';
        toggle.innerHTML = '<span class="net-dot"></span>' + tip;
      }
      const host = doc.getElementById('net-host');
      if (host) host.textContent = '创建 1v1 房间';
      const join = doc.getElementById('net-join');
      if (join) join.textContent = '加入 1v1 房间';
      const host2 = doc.getElementById('net-room-host');
      if (host2) host2.textContent = '创建 2v2 房间';
      const join2 = doc.getElementById('net-room-join');
      if (join2) join2.textContent = '加入 2v2 房间';
      const tipEl = doc.getElementById('net-row-tip');
      if (tipEl) tipEl.textContent = '一对一 · 单挑对决';
      const tip2 = doc.getElementById('net-row-tip-2v2');
      if (tip2) tip2.textContent = '四人组队 · 队友手牌互看';
    },
    /** 挂进 #start-screen；返回 controller */
    attach(ui) {
      const screen = global.document && global.document.getElementById
        ? global.document.getElementById('start-screen') : null;
      if (!screen || typeof global.document.createElement !== 'function') return null;
      if (global.document.getElementById('net-bar')) return NetUI;
      const cfg = Config.load();
      const bar = global.document.createElement('div');
      bar.id = 'net-bar';
      bar.className = 'net-bar';
      // ★ 入口按模式彻底分开：单挑模式只渲染 1v1 的「创建 / 加入」两个按钮，
      //   组队模式只渲染 2v2 的「创建 / 加入」两个按钮 —— 是两套独立 DOM，
      //   不是同一对按钮改文案。房间号输入框是两者共用的（最上面一行），
      //   切换模式时内容不丢。
      bar.innerHTML =
        '<button id="net-toggle" class="net-toggle" type="button">' +
          '<span class="net-dot"></span>联机单挑 <em>▼</em></button>' +
        '<div id="net-body" class="net-body hidden">' +
          '<div class="net-row net-room-row">' +
            '<label class="net-fld net-fld-room"><span>房间号</span>' +
              '<input id="net-room" spellcheck="false" maxlength="8" ' +
              'inputmode="numeric" ' +
              'placeholder="4 位数字" value="' + esc(cfg.room || '') + '"></label>' +
            '<span class="net-room-tip">留空则自动生成</span>' +
          '</div>' +
          '<div class="net-row net-actions net-row-1v1">' +
            '<button id="net-host" class="net-btn primary" type="button">创建 1v1 房间</button>' +
            '<button id="net-join" class="net-btn" type="button">加入 1v1 房间</button>' +
            '<span id="net-row-tip" class="net-row-tip">一对一 · 单挑对决</span>' +
          '</div>' +
          '<div class="net-row net-actions net-row-2v2">' +
            '<button id="net-room-host" class="net-btn primary" type="button">创建 2v2 房间</button>' +
            '<button id="net-room-join" class="net-btn" type="button">加入 2v2 房间</button>' +
            '<span id="net-row-tip-2v2" class="net-row-tip">四人组队 · 队友手牌互看</span>' +
          '</div>' +
          '<div class="net-row net-broker-row">' +
            '<label class="net-fld net-fld-broker"><span>中继服务器（留空 = 公共服务器）</span>' +
              '<input id="net-broker" spellcheck="false" ' +
              'placeholder="1.2.3.4:6080 或 域名（前缀可省略）" value="' +
              esc(cfg.brokerUrl && cfg.brokerUrl !== DEFAULTS.brokerUrl
                ? cfg.brokerUrl : '') + '"></label>' +
            '<button id="net-broker-test" class="net-btn ghost" type="button">测试</button>' +
          '</div>' +
          '<div id="net-broker-tip" class="net-broker-tip">' +
            '自己开服：房主电脑运行 node server/broker.js 8080，' +
            '再用 frp（自建或第三方 TCP 隧道）映射该端口，' +
            '这里填公网地址：IP:端口 或 域名，前缀 /mqtt 都可省略</div>' +
          '<div id="net-status" class="net-status"><i></i><span>未连接 · 默认本地 AI 对战</span></div>' +
        '</div>';
      const tools = global.document.getElementById('pick-tools') ||
        (screen.querySelector ? screen.querySelector('.pick-tools') : null);
      if (tools && tools.parentNode) tools.parentNode.insertBefore(bar, tools);
      else screen.insertBefore(bar, screen.firstChild);
      NetUI.setMode(NetUI.mode);

      const $ = (id) => global.document.getElementById(id);
      const toggle = $('net-toggle'), body = $('net-body');
      const statusEl = $('net-status');
      const sessionRef = { current: null };

      // ★ 链路结论由主机统一下发，单独缓存；任何状态刷新都带上它，
      //   避免「对局开始」这类提示把链路信息覆盖掉。
      NetUI.linkSuffix = '';
      const state = (text, cls) => {
        if (!statusEl) return;
        statusEl.className = 'net-status' + (cls ? ' ' + cls : '');
        const full = text + (NetUI.linkSuffix ? ' · ' + NetUI.linkSuffix : '');
        const span = statusEl.querySelector ? statusEl.querySelector('span') : null;
        if (span) span.textContent = full;
        else statusEl.textContent = full;
        // ★ 联机等候时选将栏已隐藏，状态写到战斗界面左上角（房间码后面）
        if (NetUI.waiting) {
          const ri = global.document && global.document.getElementById
            ? global.document.getElementById('round-info') : null;
          if (ri) ri.textContent = '房间 ' + (NetUI.roomCode || '') + ' · ' + full;
        }
      };
      /* ---------- 中继服务器：自建（frp）/ 公共 ---------- */
      const brokerInput = $('net-broker');
      const brokerTip = $('net-broker-tip');
      const brokerRaw = () => String((brokerInput && brokerInput.value) || '').trim();
      /** 读地址：空 = 公共；非法 / https 页面连 ws:// 都明确报错，绝不静默退回公共 */
      const brokerOf = () => {
        const raw = brokerRaw();
        if (!raw) return { url: DEFAULTS.brokerUrl, custom: false, error: '' };
        const pageProto = (global.location || {}).protocol || '';
        // ★ 前缀可以完全省略：按页面协议补 ws/wss；再兜一层 https 页面强制升级。
        let url = Net.brokerUrlForPage(
          Net.normalizeBrokerUrl(raw, pageProto), pageProto);
        if (!url) {
          return { url: '', custom: true,
            error: '中继地址格式不对，应形如 1.2.3.4:6080 或 域名（前缀可省略）' };
        }
        const bad = Net.brokerUrlProblem(url, pageProto);
        if (bad) return { url: url, custom: true, error: bad };
        return { url: url, custom: true, error: '' };
      };

      const readCfg = () => {
        const b = brokerOf();
        return {
          brokerUrl: b.url || DEFAULTS.brokerUrl,
          appId: cfg.appId || 'sanguosha',
          // ★ 自建中继口令（URL 上的 ?token= 或 localStorage 里带下来的）
          token: cfg.token || '',
          username: cfg.token || '',
          password: cfg.token || '',
          room: ($('net-room') || {}).value || ''
        };
      };

      // 测试按钮：真正连一次，报告耗时 / 失败原因（frp 没通时最有用）
      const testBtn = $('net-broker-test');
      if (testBtn && testBtn.addEventListener) {
        testBtn.addEventListener('click', () => {
          const b = brokerOf();
          if (b.error) { state(b.error, 'err'); return; }
          const url = b.url;
          state('正在测试 ' + url + ' …');
          Net.probeBroker(url, {
            username: cfg.token || '', password: cfg.token || ''
          }).then((r) => {
            // ★ https 页面 + wss：浏览器对「自签证书」的 WSS 不给点继续的机会，
            //   失败时补一句，避免误判成 frpc 没通。
            const tlsHint = (/^wss:\/\//i.test(url) &&
              ((global.location || {}).protocol || '') === 'https:')
              ? '；若服务器用自签证书，浏览器会直接拒绝 WSS，需要受信任证书'
              : '';
            if (r.ok) state('中继可用 · ' + url + ' · ' + r.ms + ' ms', 'ok');
            else if (r.error === 'timeout') {
              state('中继无响应（5 秒超时）· 检查 frpc 是否在线' + tlsHint, 'err');
            } else {
              state('中继连不上（' + r.error + '）· 检查 frpc 是否在线 / 端口是否放通' +
                tlsHint, 'err');
            }
          });
        });
      }

      /* ---------- 页面由自建中继托管时，自动填同源地址 ---------- */
      //   ★ 只有「没有存过自建地址」才自动填，绝不覆盖玩家手填的值。
      //     frp 映射后客人打开 http://公网IP:端口/ 也是同一套逻辑，零配置。
      const autoDetect = () => {
        if (brokerRaw()) return;
        const loc = global.location || {};
        if (!/^https?:$/.test(loc.protocol || '')) return;   // file:// 不探
        if (typeof global.fetch !== 'function') return;
        try {
          global.fetch('/__sgs/broker', { cache: 'no-store' })
            .then((r) => (r && r.ok ? r.json() : null))
            .then((j) => {
              if (!j || !j.ws || brokerRaw()) return;
              // ★ 反代没带 X-Forwarded-Proto 时，服务端会误判成 http；
              //   以「页面自己的协议」为准再兜一层：https 页面强制 wss。
              const wsUrl = Net.brokerUrlForPage(j.ws,
                (global.location || {}).protocol || '');
              if (brokerInput) brokerInput.value = wsUrl;
              cfg.brokerUrl = wsUrl;
              if (brokerTip) {
                brokerTip.className = 'net-broker-tip ok';
                brokerTip.textContent = '已检测到自建中继 ' + wsUrl +
                  ' · 把本页网址发给队友即可（frp 映射后同样自动识别）';
              }
            })
            .catch(() => {});
        } catch (e) { /* 探测失败就继续用公共服务器 */ }
      };
      autoDetect();
      // https 页面（例如 Pages 托管）浏览器只允许 wss://，提前说清楚
      if (((global.location || {}).protocol || '') === 'https:' && brokerTip &&
          !brokerRaw()) {
        brokerTip.className = 'net-broker-tip';
        brokerTip.textContent = '当前页面是 https：自建中继必须用 wss://' +
          '（frp 的 HTTPS 隧道 / 带证书），ws:// 会被浏览器拦截；' +
          '也可直接用 http 打开中继托管的页面。';
      }

      const start = (role) => {
        NetUI.linkSuffix = '';      // 换房间时清掉上一局的链路结论
        const b = brokerOf();
        if (b.error) { state(b.error, 'err'); return; }
        const c = readCfg();
        if (role === 'host' && !c.room) { c.room = randomRoom(); $('net-room').value = c.room; }
        if (role === 'guest' && !c.room) { state('请填写要加入的房间码', 'err'); return; }
        Config.save(c);
        if (sessionRef.current) { try { sessionRef.current.close(); } catch (e) {} }
        const sess = new (role === 'host' ? HostSession : GuestSession)({
          ui: ui, cfg: c, room: c.room,
          onState: (s) => {
            let txt = LABEL[s] || s;
            if (s === 'game:start') txt = '对局开始 · 你是一号位吗请看座位号';
            if (s === 'signal:error' && b.custom) {
              txt = '自建中继连不上 · 检查 frpc 是否在线、端口是否放通';
            }
            state(txt, /error|失败|断开/.test(txt) ? 'err'
              : /open|relay|start|init|joined/.test(s) ? 'ok' : '');
          },
          onLink: (info) => {
            // ★ 不显示「直连 / 打洞 / 中继」这类联机方式，
            //   只保留一个中性的连接状态（延迟数据仍可用于排查卡顿）。
            const rtt = info && info.rtt != null ? ' · ' + info.rtt + ' ms' : '';
            NetUI.linkSuffix = rtt;
            state('已连接（信令已断也不影响对局）', 'ok');
          }
        });
        sessionRef.current = sess;
        ui._pickNetInfo = { role: role, session: sess, room: c.room };
        if (role === 'host') state('房间 ' + c.room + ' 已创建，把房间码发给对手', 'ok');
        else state('正在加入房间 ' + c.room + ' …');
        sess.start();
      };

      // ★ 2v2：单独的四人房间（星形中继，不做 P2P），打开房间大厅
      const openRoom = (role) => {
        const b = brokerOf();
        if (b.error) { state(b.error, 'err'); return; }
        const c = readCfg();
        if (role === 'host' && !c.room) { c.room = randomRoom(); $('net-room').value = c.room; }
        if (role === 'guest' && !c.room) { state('请填写要加入的房间码', 'err'); return; }
        if (typeof Net.createRoom !== 'function') { state('房间模块未加载', 'err'); return; }
        if (sessionRef.current) { try { sessionRef.current.close(); } catch (e) {} }
        Config.save(c);
        // ★ 不在进房间时播 BGM：等真正开局（RoomHostSession.beginGame /
        //   客机 onInit）再启动，房间与选将阶段保持安静。
        const store = Net.RoomStore || { nick: () => '', avatar: () => '' };
        const sess = Net.createRoom(role, {
          ui: ui, cfg: c, room: c.room,
          nick: store.nick(), avatar: store.avatar(),
          onState: (s, x) => {
            if (s === 'room:open') state(role === 'host'
              ? '房间 ' + c.room + ' 已创建，把房间码发给队友' : '正在连接房主…');
            else if (s === 'room:join') state('队友已加入', 'ok');
            else if (s === 'room:leave') state('队友离开房间');
            else if (s === 'room:picking') state('选将中 · 队伍将池 5 选 1', 'ok');
            else if (s === 'game:start') state('对局开始', 'ok');
            else if (s === 'game:init') state('对局已同步', 'ok');
            else if (/error|失败|断开/.test(String(s))) state(LABEL[s] || s, 'err');
          }
        });
        sessionRef.current = sess;
        ui._pickNetInfo = null;
        sess.start();
      };
      NetUI.openRoom = openRoom;

      if (toggle && toggle.addEventListener) {
        toggle.addEventListener('click', () => {
          if (body) body.classList.toggle('hidden');
          toggle.classList.toggle('open');
        });
      }
      // ★ 两套入口各自固定职责，互不混用：
      //   1v1 走 HostSession / GuestSession（P2P + 中继兜底）；
      //   2v2 走四人房间（星形中继，打开房间大厅）。
      [['net-host', () => start('host')],
       ['net-join', () => start('guest')],
       ['net-room-host', () => openRoom('host')],
       ['net-room-join', () => openRoom('guest')]]
        .forEach(([id, fn]) => {
        const b = $(id); if (b && b.addEventListener) b.addEventListener('click', fn);
      });
      NetUI.session = sessionRef;
      NetUI.state = state;
      return NetUI;
    }
  };

  /**
   * ★ 联机等候界面 = 原来的战斗界面氛围底图（background3.webp / CSS 远景），
   *   不另盖一层不透明遮罩 —— 用户明确喜欢这套画面。
   *   只是把「写死的占位」换成真实状态：
   *     · 右下角角色框 = 自己刚选的角色（立绘 / 势力 / 名字 / 体力都填）
   *     · 对方角色框空着不显示（整块隐藏，不预设任何对手）
   *     · 右上角牌堆 = 160 张（整副牌总数）
   *     · 左上角写房间码 + 实时连接状态
   *   开局后 hideWait() 复原，之后完全交给 ui.render() 填真实值。
   */
  NetUI.showWait = function (ui, charId, role, room) {
    const doc = global.document;
    if (!doc || !doc.getElementById) return;
    const $ = (id) => doc.getElementById(id);
    NetUI.waiting = true;
    NetUI.roomCode = room || '';
    const c = (SGS.Characters || {})[charId] || {};
    const art = (ui && ui.art && ui.art.characters)
      ? ui.art.characters[charId] : '';
    const shown = c.displayName || c.name || charId || '?';
    const faction = c.faction || '群';
    const hp = Math.max(1, c.maxHp || 4);

    // ① 对方角色框空着不显示
    const aiArea = $('ai-area');
    if (aiArea && aiArea.style) aiArea.style.display = 'none';

    // ② 右下角角色框换成自己选的角色（与局内 render 完全同一套字段）
    if ($('me-name')) $('me-name').textContent = shown;
    const ff = $('me-faction');
    if (ff) { ff.textContent = faction; if (ff.dataset) ff.dataset.faction = faction; }
    if ($('me-hp') && ui && typeof ui.hpHTML === 'function') {
      $('me-hp').innerHTML = ui.hpHTML({ char: c, name: shown, hp: hp, maxHp: hp, hand: [] });
    }
    if ($('me-count')) $('me-count').textContent = '';
    if ($('ai-count')) $('ai-count').textContent = '';
    const meArea = $('me-area'), meArt = $('me-art');
    if (meArea && meArea.style && typeof meArea.style.setProperty === 'function') {
      meArea.style.setProperty('--name-scale', (1 / Math.max(1, shown.length)).toFixed(4));
      meArea.style.setProperty('--hp-pips', String(hp));
    }
    if (meArt && meArea) {
      if (art) {
        if (meArt.src !== art) meArt.src = art;
        if (meArt.dataset) meArt.dataset.art = art;
        if (meArea.classList) meArea.classList.add('has-art');
      } else if (meArea.classList) {
        meArea.classList.remove('has-art');
      }
    }

    // ③ 右上角牌堆数 = 整副牌 160 张
    if ($('deck-info')) $('deck-info').textContent = '牌堆 160 张';
    // ④ 左上角房间码 + 状态；中央一行轻提示
    if ($('round-info')) $('round-info').textContent =
      '房间 ' + NetUI.roomCode + ' · ' + (role === 'host' ? '等待对手加入…' : '等待房主开局…');
    if ($('hint')) $('hint').textContent = '等待对局开始…';
    // ⑤ 清掉任何残留的手牌 / 展示区 / 操作按钮，保持画面干净
    ['me-hand', 'table-card', 'actions', 'skill-actions', 'me-judge-marks',
      'me-equip-area'].forEach((id) => {
      const e = $(id);
      if (e && typeof e.innerHTML === 'string') e.innerHTML = '';
    });
    const log = $('log'); if (log && typeof log.innerHTML === 'string') log.innerHTML = '';
  };
  NetUI.hideWait = function () {
    NetUI.waiting = false;
    const doc = global.document;
    if (!doc || !doc.getElementById) return;
    const $ = (id) => doc.getElementById(id);
    // ★ 必须复原对方框的 inline display，否则 render() 之后对手一直不出现
    const aiArea = $('ai-area');
    if (aiArea && aiArea.style) aiArea.style.display = '';
    if ($('hint')) $('hint').textContent = '';
    if ($('round-info')) $('round-info').textContent = '';
    if ($('deck-info')) $('deck-info').textContent = '牌堆 160 张';
  };

  /** main.js 用的挂载入口（NetUI.attach 的别名，内部只用闭包 NetUI，不依赖 this） */
  Net.attach = NetUI.attach;

  /** 创建联机会话（也可供测试直接调用） */
  Net.create = function (role, cfg, ui, opts) {
    const C = role === 'host' ? HostSession : GuestSession;
    return new C(Object.assign({ cfg: cfg, ui: ui, room: cfg.room }, opts || {}));
  };
})(typeof window !== 'undefined' ? window : globalThis);
