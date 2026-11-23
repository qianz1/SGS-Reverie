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
  const DEFAULTS = {
    brokerUrl: '', appId: 'sanguosha',
    turnUrl: '', turnUser: '', turnCred: ''
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
        JSON.stringify({ brokerUrl: cfg.brokerUrl || '', appId: cfg.appId || 'sanguosha',
          turnUrl: cfg.turnUrl || '', turnUser: cfg.turnUser || '',
          turnCred: cfg.turnCred || '' })); } catch (e) {}
    },
    fromUrl() {
      const out = {};
      try {
        const q = new URLSearchParams(global.location ? global.location.search : '');
        [['broker', 'brokerUrl'], ['appid', 'appId'], ['room', 'room'],
         ['turn', 'turnUrl'], ['turnuser', 'turnUser'], ['turncred', 'turnCred']]
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

  class RouterUI {
    constructor(localUI, remoteUI) {
      this.localUI = localUI;
      this.remoteUI = remoteUI;
      const self = this;
      const proto = (SGS.UI && SGS.UI.prototype) || {};
      Object.getOwnPropertyNames(proto).forEach((name) => {
        if (name === 'constructor' || WAIT_INDEX[name] != null) return;
        if (typeof proto[name] !== 'function') return;
        self[name] = function () {
          const fn = localUI[name];
          return typeof fn === 'function' ? fn.apply(localUI, arguments) : undefined;
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
        iceServers: Net.defaultIceServers({
          url: this.cfg.turnUrl, username: this.cfg.turnUser,
          credential: this.cfg.turnCred
        }),
        RTCPeerConnectionImpl: opts.RTCPeerConnectionImpl,
        onSignal: (type, data) => self.sig.sendSignal(type, data),
        onOpen: () => { self.onState('channel:open'); self.flushFrames(); },
        onClose: (why) => self.onState('channel:close', { why: why }),
        onMessage: (m) => self.onFrame(m),
        onLink: (info) => self.onLink(info)
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
        case 'over': this.onOver(m); break;
        default: break;
      }
    }
    onChar() {} onInit() {} onSnap() {} onAsk() {}
    onActFrame() {} onOver() {}
    onLogFrame(m) {
      try { if (this.ui && typeof this.ui.log === 'function') this.ui.log(m.m, m.c); }
      catch (e) {}
    }

    /** 选将完成：把角色发给对端；两边齐了才开局 */
    startGame(charId) {
      this.myCharId = charId;
      this.send({ t: 'char', charId: charId, role: this.role });
      if (this.role === 'host') this.maybeBegin();
      else this.onState('waiting-host');
    }
    maybeBegin() {}

    close() {
      try { this.sig.close(); } catch (e) {}
      try { this.transport.close(); } catch (e) {}
      this.ui.onRender = null; this.ui.onLog = null;
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
      const ui = this.ui;
      const router = new RouterUI(ui, this.remoteUI);
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
    pushSnapshot(immediate) {
      if (!this.game) return;
      const self = this;
      const emit = () => {
        self._snapTimer = null;
        self.send({ t: 'snap', snap: P.makeSnapshot(self.game, self.remoteSeat) });
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
    }
    onInit(m) {
      this.mySeat = m.seat;
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
      P.applySnapshot(this.viewGame, m.snap);
      this.viewGame.viewerSeat = seat;
      try { this.ui.render(this.viewGame); } catch (e) {}
      // 五谷面板由快照驱动重绘
      if (this.ui.wuguSession && typeof this.ui.renderWuguPanel === 'function') {
        try { this.ui.renderWuguPanel(); } catch (e) {}
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
          '<div class="net-row">' +
            '<label class="net-fld"><span>Broker WSS</span>' +
              '<input id="net-broker" type="url" spellcheck="false" ' +
              'placeholder="wss://your-broker:8084/mqtt" value="' + esc(cfg.brokerUrl) + '"></label>' +
            '<label class="net-fld net-fld-sm"><span>房间码</span>' +
              '<input id="net-room" spellcheck="false" maxlength="12" ' +
              'value="' + esc(cfg.room || '') + '"></label>' +
          '</div>' +
          '<div class="net-row net-adv">' +
            '<label class="net-fld"><span>TURN（可选，打洞失败时兜底）</span>' +
              '<input id="net-turn" spellcheck="false" placeholder="turn:example.com:3478" ' +
              'value="' + esc(cfg.turnUrl) + '"></label>' +
            '<label class="net-fld net-fld-sm"><span>账号 / 密码（可选）</span>' +
              '<span class="net-pair"><input id="net-turnuser" placeholder="user" value="' +
                esc(cfg.turnUser) + '"><input id="net-turncred" placeholder="credential" value="' +
                esc(cfg.turnCred) + '"></span></label>' +
          '</div>' +
          '<div class="net-row net-actions">' +
            '<button id="net-host" class="net-btn primary" type="button">创建房间</button>' +
            '<button id="net-join" class="net-btn" type="button">加入房间</button>' +
            '<button id="net-local" class="net-btn ghost" type="button">返回本地对战</button>' +
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

      const state = (text, cls) => {
        if (!statusEl) return;
        statusEl.className = 'net-status' + (cls ? ' ' + cls : '');
        const span = statusEl.querySelector ? statusEl.querySelector('span') : null;
        if (span) span.textContent = text;
        else statusEl.textContent = text;
      };
      const readCfg = () => ({
        brokerUrl: ($('net-broker') || {}).value || '',
        appId: cfg.appId || 'sanguosha',
        room: ($('net-room') || {}).value || '',
        turnUrl: ($('net-turn') || {}).value || '',
        turnUser: ($('net-turnuser') || {}).value || '',
        turnCred: ($('net-turncred') || {}).value || ''
      });
      const start = (role) => {
        const c = readCfg();
        if (!c.brokerUrl) { state('请先填写 Broker WSS 地址', 'err'); return; }
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
              : info.kind === 'srflx' ? '公网打洞' : 'TURN 中继';
            const rtt = info.rtt == null ? '' : ' · ' + info.rtt + ' ms';
            state('已直连 · ' + kind + rtt + '（信令已断也不影响对局）', 'ok');
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
      [['net-host', () => start('host')], ['net-join', () => start('guest')],
       ['net-local', () => {
         if (sessionRef.current) { try { sessionRef.current.close(); } catch (e) {} }
         sessionRef.current = null; ui._pickNetInfo = null;
         state('已切回本地 AI 对战');
       }]].forEach(([id, fn]) => {
        const b = $(id); if (b && b.addEventListener) b.addEventListener('click', fn);
      });
      NetUI.session = sessionRef;
      NetUI.state = state;
      return NetUI;
    }
  };

  /** main.js 用的挂载入口（NetUI.attach 的别名，内部只用闭包 NetUI，不依赖 this） */
  Net.attach = NetUI.attach;

  /** 创建联机会话（也可供测试直接调用） */
  Net.create = function (role, cfg, ui, opts) {
    const C = role === 'host' ? HostSession : GuestSession;
    return new C(Object.assign({ cfg: cfg, ui: ui, room: cfg.room }, opts || {}));
  };
})(typeof window !== 'undefined' ? window : globalThis);
