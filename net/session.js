/**
 * net/session.js — 联机会话编排（主机权威 / 客机视图 / 联机面板）
 *
 * 架构三层（对应前面定下的口径）：
 *   Pages 静态前端  →  MQTT over WSS 只做建连信令  →  WebRTC DataChannel 直传
 *   主机浏览器跑完整 SGS.Game（唯一权威），客机只有一个「视图 Game」。
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
  // ★ 固定公共 broker，不再让用户输入地址；TURN 兜底整体移除，
  //   只保留 STUN 打洞（打不通就明确提示，不再悄悄绕中继）。
  const DEFAULTS = {
    brokerUrl: 'wss://broker-cn.emqx.io:8084/mqtt', appId: 'sanguosha'
  };
  const Config = Net.Config = {
    DEFAULTS: DEFAULTS,
    load() {
      let saved = {};
      try { saved = JSON.parse(global.localStorage && global.localStorage.getItem(CFG_KEY) || '{}'); }
      catch (e) { saved = {}; }
      const url = Net.Config.fromUrl();
      return Object.assign({}, DEFAULTS, saved, url);
    },
    save(cfg) {
      try { global.localStorage && global.localStorage.setItem(CFG_KEY,
        JSON.stringify({ appId: cfg.appId || 'sanguosha' })); } catch (e) {}
    },
    fromUrl() {
      const out = {};
      try {
        const q = new URLSearchParams(global.location ? global.location.search : '');
        [['broker', 'brokerUrl'], ['appid', 'appId'], ['room', 'room']]
          .forEach(([k, v]) => { if (q.get(k)) out[v] = q.get(k); });
      } catch (e) {}
      return out;
    }
  };

  /* ================= 决策路由 ================= */
  // waitXxx 的「决策者」参数下标。绝大多数是第 0 个，少数第一个是 game。
  const WAIT_INDEX = {
    waitPlay: 0, waitRespond: 0, waitDiscard: 0, waitPick: 0, waitBrink: 0,
    waitTarget: 0, waitTargets: 0, waitWugu: 1, waitPeekHand: 0,
    waitChainTargets: 0, waitChoice: 0, waitTrickCard: 1,
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
    'closePeekPanel', 'closeTargetPanel'
  ];
  Net.FX_METHODS = FX_METHODS;

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
        self.waiters[id] = resolve;
        if (self.session.pushSnapshot) self.session.pushSnapshot(true);
        self.session.send({
          t: 'ask', id: id, method: method,
          args: P.packArgs(Array.prototype.slice.call(args), self.game, self.remoteSeat)
        });
      });
    }
    onAct(id, value) {
      const fn = this.waiters[id];
      if (!fn) return;
      delete this.waiters[id];
      fn(P.unpackAct(value, this.game));
    }
  }
  Net.RemoteUI = RemoteUI;

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
      const self = this;

      this.sig = new Net.Signaling({
        brokerUrl: this.cfg.brokerUrl, appId: this.cfg.appId, room: this.room,
        role: this.role, username: this.cfg.username, password: this.cfg.password,
        WebSocketImpl: opts.WebSocketImpl,
        onState: (s, x) => self.onState('signal:' + s, x),
        onPresence: (m) => self.onState('presence', m),
        onSignal: (type, data) => self.onSignal(type, data)
      });
      this.sid = this.sig.sid;
      this.transport = new Net.Transport({
        role: this.role, sid: this.sid,
        iceServers: Net.defaultIceServers(),
        RTCPeerConnectionImpl: opts.RTCPeerConnectionImpl,
        onSignal: (type, data) => self.sig.sendSignal(type, data),
        onOpen: () => { self.onState('channel:open'); self.flushFrames(); },
        onClose: (why) => self.onState('channel:close', { why: why }),
        onMessage: (m) => self.onFrame(m),
        // ★ 两端各自 getStats() 的 local candidate 是镜像的，直接各显示各的
        //   会出现「一边局域网直连、一边公网打洞」。统一由主机测一次，
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
      return this;
    }

    onSignal(type, data) {
      if (type === 'hello' && this.role === 'host') {
        this.onState('peer:joined');
        if (this._offerPending) {
          this._offerPending = false;
          this.transport.makeOffer().catch(() => {});
        }
        return;
      }
      if (type === 'offer') { this.transport.acceptOffer(data).catch(() => {}); return; }
      if (type === 'answer') { this.transport.acceptAnswer(data).catch(() => {}); return; }
      if (type === 'candidate') { this.transport.addCandidate(data).catch(() => {}); return; }
    }

    /** DataChannel 未 open 时排队，绝不静默丢动作 */
    send(frame) {
      if (!this.transport.ready) { this._frameQueue.push(frame); return; }
      this.transport.send(frame);
    }
    flushFrames() {
      const list = this._frameQueue.splice(0);
      list.forEach((f) => this.transport.send(f));
    }

    onFrame(m) {
      if (!m || !m.t) return;
      switch (m.t) {
        case 'char': this.onChar(m); break;
        case 'init': this.onInit(m); break;
        case 'snap': this.onSnap(m); break;
        case 'ask': this.onAsk(m); break;
        case 'act': this.onActFrame(m); break;
        case 'log': this.onLogFrame(m); break;
        case 'fx': this.onFxFrame(m); break;
        case 'link': if (this.role === 'guest') this.onLink(m.info); break;
        case 'over': this.onOver(m); break;
        default: break;
      }
    }
    onChar() {} onInit() {} onSnap() {} onAsk() {} onFxFrame() {}
    onActFrame() {} onOver() {}
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
      if (!this.transport.ready) {   // 数据面没通就等，不丢开局
        this._beginPending = true;
        return;
      }
      this.begin();
    }
    flushFrames() {
      super.flushFrames();
      if (this._beginPending) { this._beginPending = false; this.maybeBegin(); }
    }
    begin() {
      this.started = true;
      if (NetUI && NetUI.hideWait) { try { NetUI.hideWait(); } catch (e) {} }
      const ui = this.ui;
      const self0 = this;
      const router = new RouterUI(ui, this.remoteUI, (name, args) => {
        const safe = args.slice();
        // animateDraw 的第 3 个参数是 Game，其余表现事件的第 3 个是 opts
        const opts = (name !== 'animateDraw' && safe[2] &&
          typeof safe[2] === 'object' && !Array.isArray(safe[2])) ? safe[2] : {};
        const game = self0.game;
        // ★★ 正反面的唯一口径：先提炼「提供者 / 获得者」座位，再对【每一个】
        //   收件人单独判定能不能看正面（P.canSeeFxFace）。绝不「算一次就群发」——
        //   多人局里那样必然串味：一份 frame 只能带一个 hide 标志，
        //   而「能不能看正面」本来就是因人而异的。
        //   座位号是全局唯一的，因此这条判断与视角、人数、谁是房主都无关。
        const seats = P.fxFaceSeats(name, safe, {
          localSeat: game && game.human ? game.human.seat : null,
          remoteSeats: self0.recipientSeats()
        });
        const toHand = name === 'animateDraw' ||
          opts.dest === 'hand' || opts.dest === 'ai-hero';
        // ★ 同事务：先推一份当前权威快照，再发 fx。DataChannel 可靠有序，
        //   客机一定先应用视图状态、再重放动画，不会被随后到达的快照重建打断。
        const tx = ++self0._tx;
        self0.pushSnapshot(true);
        self0.recipientSeats().forEach((seat) => {
          const seeFace = P.canSeeFxFace(seat, seats.providerSeat,
            seats.receiverSeat, seats.publicFace);
          // 进手牌区（摸牌 / 获得牌）：只有提供者与获得者看正面，其余人一律牌背。
          // 展示区亮牌 / 弃牌（没有获得者）：沿用 opts.faceDown 声明，
          // 但提供者自己永远看正面 —— 他本来就知道这张牌是什么。
          const hide = toHand ? !seeFace
            : (!!opts.faceDown && !(seats.providerSeat != null &&
                String(seats.providerSeat) === String(seat)));
          // 每个收件人各自一份参数副本，牌面按需替换成牌背（互不影响）
          const out = safe.slice();
          if (hide && out[0]) out[0] = P.hideCardFaces(out[0]);
          // ★ recv（获得者）+ src（提供者）随帧下发：客机拿这两个座位号
          //   自己再判一次，不依赖任何坐标 / 落点约定，换视角也不会错。
          self0.send({ t: 'fx', tx: tx, m: name, hide: !!hide,
            recv: seats.receiverSeat, src: seats.providerSeat, to: seat,
            pub: seats.publicFace ? 1 : 0,
            a: P.packFxArgs(out, game, seat) });
        });
      });
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
      const self = this;
      // ★ 每次状态渲染都推一次按座位裁剪的快照（合并 24ms 内的连续 render）
      ui.onRender = () => self.pushSnapshot();
      ui.onLog = (m, c) => self.send({ t: 'log', m: m, c: c });
      this.send({ t: 'init', seat: this.remoteSeat,
        hostCharId: this.myCharId, guestCharId: this.remoteCharId,
        hostSeat: game.human.seat });
      this.pushSnapshot(true);
      this.onState('game:start');
      game.run().then(() => {
        const alive = (game.players || []).find((p) => !p.isDead());
        const hostWon = !!(alive && alive === game.human);
        self.send({ t: 'over', hostWon: hostWon });
      }).catch(() => {});
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
      if (immediate) emit(); else this._snapTimer = setTimeout(emit, 24);
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
      this.ui.bindGame(this.viewGame);
      this.ui.vsAI = false;
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
        const mine = m.recv != null ? seatIsMe(m.recv) : isMine(player);
        const seatSee = seatSays(null, m.recv, false);
        // 摸牌没有提供者：只有获得者能看正面
        const face = (seatSee == null ? mine : seatSee) && !m.hide;
        cards.forEach((c, i) => {
          // ★ 多张按 1/3 卡宽错位、逐张错峰起飞，与主机 animateDrawToAI
          //   的「露出 1 / 盖住 2」叠放观感一致，不再几张完全重叠。
          try { ui.flyCard(c, player, { from: 'table',
            dest: mine ? 'hand' : 'ai-hero', faceDown: !face,
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
        const mine = m.recv != null ? seatIsMe(m.recv) : isMine(o.toPlayer);
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
      const ui = this.ui;
      const fn = ui && ui[m.method];
      if (typeof fn !== 'function') { this.send({ t: 'act', id: m.id, value: null }); return; }
      const args = P.unpackArgs(m.args, this.viewGame);
      fn.apply(ui, args);
      const pd = ui.pending;
      if (!pd || !pd.resolve) { this.send({ t: 'act', id: m.id, value: null }); return; }
      const orig = pd.resolve;
      const self = this;
      // ★ 本地 finish() 照常清理界面，同时把最终动作上送给权威端
      pd.resolve = (v) => {
        orig(v);
        self.send({ t: 'act', id: m.id, value: P.packAct(v) });
      };
    }
    onOver(m) {
      try { this.ui.showGameOver(!m.hostWon); } catch (e) {}
      this.onState('game:over');
    }
  }
  Net.GuestSession = GuestSession;

  /* ================= 联机面板（动态挂载进选将层） ================= */
  const LABEL = {
    'signal:connecting': '正在连接信令…', 'signal:connected': '信令已连接',
    'signal:disconnected': '信令断开，正在重连…', 'signal:error': '信令连接失败',
    'peer:joined': '对手已加入，正在建连…', 'channel:open': '已直连，等待开局',
    'channel:close': '数据通道断开', 'presence': '房间状态更新',
    'waiting-host': '已选将，等待房主开局…', 'game:init': '对局已同步',
    'game:start': '对局开始', 'game:over': '对局结束'
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function randomRoom() {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }
  Net.randomRoom = randomRoom;

  const NetUI = Net.UI = {
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
      bar.innerHTML =
        '<button id="net-toggle" class="net-toggle" type="button">' +
          '<span class="net-dot"></span>联机对战 <em>▼</em></button>' +
        '<div id="net-body" class="net-body hidden">' +
          '<div class="net-row net-actions">' +
            '<label class="net-fld net-fld-room"><span>房间号</span>' +
              '<input id="net-room" spellcheck="false" maxlength="12" ' +
              'placeholder="6 位房间码" value="' + esc(cfg.room || '') + '"></label>' +
            '<button id="net-host" class="net-btn primary" type="button">创建房间</button>' +
            '<button id="net-join" class="net-btn" type="button">加入房间</button>' +
          '</div>' +
          '<div id="net-status" class="net-status"><i></i><span>未连接 · 默认本地 AI 对战</span></div>' +
        '</div>';
      const tools = global.document.getElementById('pick-tools') ||
        (screen.querySelector ? screen.querySelector('.pick-tools') : null);
      if (tools && tools.parentNode) tools.parentNode.insertBefore(bar, tools);
      else screen.insertBefore(bar, screen.firstChild);

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
      const readCfg = () => ({
        brokerUrl: cfg.brokerUrl || DEFAULTS.brokerUrl,
        appId: cfg.appId || 'sanguosha',
        room: ($('net-room') || {}).value || ''
      });
      const start = (role) => {
        NetUI.linkSuffix = '';      // 换房间时清掉上一局的链路结论
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
            state(txt, /error|失败|断开/.test(txt) ? 'err'
              : /open|start|init|joined/.test(s) ? 'ok' : '');
          },
          onLink: (info) => {
            const kind = info.kind === 'host' ? '局域网直连'
              : info.kind === 'srflx' ? '公网打洞' : '中继';
            const rtt = info.rtt == null ? '' : ' · ' + info.rtt + ' ms';
            NetUI.linkSuffix = kind + rtt;
            state('已直连（信令已断也不影响对局）', 'ok');
          }
        });
        sessionRef.current = sess;
        ui._pickNetInfo = { role: role, session: sess, room: c.room };
        if (role === 'host') state('房间 ' + c.room + ' 已创建，把房间码发给对手', 'ok');
        else state('正在加入房间 ' + c.room + ' …');
        sess.start();
      };

      if (toggle && toggle.addEventListener) {
        toggle.addEventListener('click', () => {
          if (body) body.classList.toggle('hidden');
          toggle.classList.toggle('open');
        });
      }
      [['net-host', () => start('host')], ['net-join', () => start('guest')]]
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
