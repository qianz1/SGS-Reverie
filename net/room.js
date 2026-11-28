/**
 * net/room.js — 2v2 组队房间（四人联机）
 *
 * 拓扑（与 1v1 的 P2P 不同）：
 *   房主浏览器跑权威 SGS.Game，三台客机只渲染视图；
 *   所有帧都经 MQTT broker 的 inbox 转发（星形中继），
 *   不再为四台机器维护 3 条 WebRTC —— 弱网下更稳，代码也简单得多。
 *
 * 阶段：
 *   房间大厅  → 点「开始游戏」→ 等候界面（角色框全空）+ 队伍选将
 *   → 四人（不足用 AI 补位）选完 → 房主开局 → init / snap / ask / fx
 *
 * 选将：同一阵营共用 5 张将池且不能重复；AI 位从剩余将池里自动补。
 * 昵称 / 头像：昵称显示在房间与局内角色框上方；头像只用于房间。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Net = SGS.Net || (SGS.Net = {});
  const P = Net.Protocol;

  const SLOT_N = 4;
  const TEAM_OF_SLOT = ['A', 'A', 'B', 'B'];      // 房间左列 / 右列
  const SEATS_OF_TEAM = { A: [1, 4], B: [2, 3] };  // 局内号位
  const POOL_SIZE = 5;

  const $ = (id) => (global.document && global.document.getElementById
    ? global.document.getElementById(id) : null);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shuffle(arr, rng) {
    const a = arr.slice();
    const r = typeof rng === 'function' ? rng : Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function charIds() {
    return Object.keys(SGS.Characters || {}).filter((k) => SGS.Characters[k]);
  }

  /* ================= 昵称 / 头像（本地保存） ================= */
  const NICK_KEY = 'sgs_room_nick_v1';
  const AVATAR_KEY = 'sgs_room_avatar_v1';
  const NICK_BASE = ['子龙', '伯约', '公瑾', '仲谋', '孟德', '玄德', '翼德',
    '孔明', '奉孝', '文远', '汉升', '子敬'];

  const Store = Net.RoomStore = {
    nick() {
      try {
        const v = global.localStorage && global.localStorage.getItem(NICK_KEY);
        if (v) return v;
      } catch (e) {}
      return '';
    },
    setNick(v) {
      try { global.localStorage && global.localStorage.setItem(NICK_KEY, String(v || '')); }
      catch (e) {}
    },
    avatar() {
      try {
        return (global.localStorage && global.localStorage.getItem(AVATAR_KEY)) || '';
      } catch (e) { return ''; }
    },
    setAvatar(v) {
      try {
        global.localStorage && global.localStorage.setItem(AVATAR_KEY, String(v || ''));
      } catch (e) {}
    },
    randomNick() {
      const base = NICK_BASE[Math.floor(Math.random() * NICK_BASE.length)];
      return base + Math.floor(10 + Math.random() * 90);
    },
    /** 把本地图片压成 96×96 的 JPEG dataURL（体积小，能随 hello 一起发） */
    fileToAvatar(file) {
      return new Promise((resolve) => {
        try {
          const Reader = global.FileReader;
          const Img = global.Image;
          if (!Reader || !Img || !global.document || !global.document.createElement) {
            resolve(''); return;
          }
          const reader = new Reader();
          reader.onload = () => {
            const img = new Img();
            img.onload = () => {
              try {
                const size = 96;
                const cv = global.document.createElement('canvas');
                cv.width = size; cv.height = size;
                const ctx = cv.getContext && cv.getContext('2d');
                if (!ctx) { resolve(''); return; }
                const w = img.width || 1, h = img.height || 1;
                const d = Math.min(w, h);
                ctx.drawImage(img, (w - d) / 2, (h - d) / 2, d, d, 0, 0, size, size);
                resolve(cv.toDataURL('image/jpeg', 0.82));
              } catch (e) { resolve(''); }
            };
            img.onerror = () => resolve('');
            img.src = reader.result;
          };
          reader.onerror = () => resolve('');
          reader.readAsDataURL(file);
        } catch (e) { resolve(''); }
      });
    }
  };

  /** 默认头像：按昵称算一个稳定色相，CSS 画渐变 + 首字 */
  function avatarHTML(avatar, nick, cls) {
    const name = String(nick || '?');
    if (avatar) {
      return '<div class="room-avatar ' + (cls || '') + '">' +
        '<img class="room-avatar-img" src="' + esc(avatar) + '" alt=""></div>';
    }
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return '<div class="room-avatar default ' + (cls || '') + '" style="--av-h:' + h + '">' +
      '<span>' + esc(name.slice(0, 1)) + '</span></div>';
  }

  /* ================= 房间大厅 UI ================= */
  const RoomUI = Net.RoomUI = {
    handlers: {},
    pickHandlers: {},
    _bound: false,
    _state: null,
    _myPeerId: null,
    _pick: null,

    bind(handlers) { this.handlers = handlers || {}; },

    open(opts) {
      opts = opts || {};
      const screen = $('room-screen');
      if (!screen) return false;
      this.bindStatic();
      this.probeBg();
      const startScreen = $('start-screen');
      if (startScreen && startScreen.classList) startScreen.classList.add('hidden');
      if (screen.classList) screen.classList.remove('hidden');
      this.hideAsk();
      const code = $('room-code');
      if (code) code.textContent = opts.room || '';
      const roleTag = $('room-role');
      if (roleTag) roleTag.textContent = opts.role === 'host' ? '房主' : '玩家';
      const startBtn = $('room-start');
      if (startBtn) startBtn.classList.toggle('hidden', opts.role !== 'host');
      const rand = $('room-random-team');
      if (rand) {
        rand.parentNode && rand.parentNode.classList &&
          rand.parentNode.classList.toggle('hidden', opts.role !== 'host');
      }
      this.setStatus(opts.role === 'host'
        ? '房间已创建，把房间码发给队友；不足 4 人时由 AI 补位'
        : '正在连接房主…');
      this.setProfile(opts.nick || '', opts.avatar || '');
      return true;
    },

    /**
     * 房间背景 = 战斗界面同一张底图（background3.webp）。
     * 只在加载成功后加 .has-art 显示图片；失败 / 缺失保持纯 CSS 远景。
     */
    probeBg() {
      this.probeImage('room-bg-wrap', 'room-bg',
        'assets/backgrounds/background3.webp', '_bgDone');
    },

    /**
     * 队伍选将背景 = 战斗界面同一张底图（background3.webp）。
     * 与房间 / 战场保持同一套视觉；加载成功才显示，失败回退 CSS 远景。
     */
    probePickBg() {
      this.probeImage('team-pick-bg-wrap', 'team-pick-bg',
        'assets/backgrounds/background3.webp', '_pickBgDone');
    },

    /** 通用底图探测：成功 → wrap 加 .has-art 并显示 img；失败 → 保持 CSS 回退 */
    probeImage(wrapId, imgId, url, flag) {
      const wrap = $(wrapId), img = $(imgId);
      if (!wrap || !img || !wrap.classList) return;
      if (this[flag]) return;
      this[flag] = true;
      const ok = () => { wrap.classList.add('has-art'); };
      const bad = () => { wrap.classList.remove('has-art'); };
      if (img.complete && img.naturalWidth) { ok(); return; }
      img.onload = ok;
      img.onerror = bad;
      img.src = url;
    },

    close() {
      const screen = $('room-screen');
      if (screen && screen.classList) screen.classList.add('hidden');
    },

    bindStatic() {
      if (this._bound) return;
      this._bound = true;
      const h = () => this.handlers;
      const copy = $('room-copy');
      if (copy && copy.addEventListener) {
        copy.addEventListener('click', () => {
          const code = ($('room-code') || {}).textContent || '';
          try {
            if (global.navigator && global.navigator.clipboard) {
              global.navigator.clipboard.writeText(code);
            }
          } catch (e) {}
          this.setStatus('房间码已复制：' + code, 'ok');
        });
      }
      const leave = $('room-leave');
      if (leave && leave.addEventListener) {
        leave.addEventListener('click', () => { if (h().onLeave) h().onLeave(); });
      }
      const nick = $('room-nick');
      if (nick && nick.addEventListener) {
        nick.addEventListener('input', () => {
          const v = String(nick.value || '').slice(0, 8);
          if (h().onNick) h().onNick(v);
        });
      }
      const file = $('room-avatar-file');
      if (file && file.addEventListener) {
        file.addEventListener('change', () => {
          const f = file.files && file.files[0];
          if (!f) return;
          Store.fileToAvatar(f).then((url) => {
            if (!url) { this.setStatus('图片读取失败，换一张试试', 'err'); return; }
            Store.setAvatar(url);
            this.setProfile((($('room-nick') || {}).value) || '', url);
            if (h().onAvatar) h().onAvatar(url);
          });
        });
      }
      const rand = $('room-random-team');
      if (rand && rand.addEventListener) {
        rand.addEventListener('change', () => {
          if (h().onRandomTeams) h().onRandomTeams(!!rand.checked);
        });
      }
      const start = $('room-start');
      if (start && start.addEventListener) {
        start.addEventListener('click', () => { if (h().onStart) h().onStart(); });
      }
      // ★ 换位置：点击空位直接换过去，点击别人的位置发起「交换位置」申请。
      //   两列共用一个委托监听，重绘（innerHTML）不会丢掉绑定。
      ['room-slots-a', 'room-slots-b'].forEach((id) => {
        const box = $(id);
        if (!box || !box.addEventListener) return;
        box.addEventListener('click', (e) => {
          const t = e && e.target;
          const slotEl = t && typeof t.closest === 'function' ? t.closest('.room-slot') : null;
          if (!slotEl || !slotEl.dataset) return;
          if (!slotEl.classList || !slotEl.classList.contains('can-move')) return;
          const slot = Number(slotEl.dataset.slot);
          if (isNaN(slot)) return;
          if (h().onSlotClick) h().onSlotClick(slot);
        });
      });
      const askYes = $('room-ask-yes');
      if (askYes && askYes.addEventListener) {
        askYes.addEventListener('click', () => {
          const fn = this._askYes;
          this.hideAsk();
          if (typeof fn === 'function') fn();
        });
      }
      const askNo = $('room-ask-no');
      if (askNo && askNo.addEventListener) {
        askNo.addEventListener('click', () => {
          const fn = this._askNo;
          this.hideAsk();
          if (typeof fn === 'function') fn();
        });
      }
      // 选将面板：事件委托（卡片每次重绘）。只有框下方的「选择此将」按钮可点，
      // 已选 / 队友已选的按钮是 disabled 的。
      const cards = $('team-pick-cards');
      if (cards && cards.addEventListener) {
        cards.addEventListener('click', (e) => {
          const t = e && e.target;
          const btn = t && typeof t.closest === 'function' ? t.closest('.tp-pick') : null;
          if (!btn || !btn.dataset) return;
          if (btn.disabled) return;
          if (btn.classList && btn.classList.contains('taken')) return;
          if (this.pickHandlers.onPick) this.pickHandlers.onPick(btn.dataset.id);
        });
      }
    },

    setStatus(text, cls) {
      const el = $('room-status');
      if (!el) return;
      el.className = 'room-status' + (cls ? ' ' + cls : '');
      el.textContent = String(text || '');
    },

    setProfile(nick, avatar) {
      const inp = $('room-nick');
      if (inp && inp.value !== nick) inp.value = nick;
      const box = $('room-me-avatar');
      if (box) box.innerHTML = avatarHTML(avatar, nick, 'small');
    },

    setRandomTeams(on) {
      const el = $('room-random-team');
      if (el) el.checked = !!on;
    },

    render(state, myPeerId) {
      if (!state) return;
      this._state = state;
      this._myPeerId = myPeerId;
      const code = $('room-code');
      if (code) code.textContent = state.room || code.textContent;
      this.setRandomTeams(state.randomTeams);
      const boxA = $('room-slots-a'), boxB = $('room-slots-b');
      if (boxA) boxA.innerHTML = this.slotHTML(state, 0) + this.slotHTML(state, 1);
      if (boxB) boxB.innerHTML = this.slotHTML(state, 2) + this.slotHTML(state, 3);
      const startBtn = $('room-start');
      if (startBtn) {
        const mine = (state.slots || []).find((s) => s && s.peerId === myPeerId);
        const isHost = !!(mine && mine.host);
        startBtn.classList.toggle('hidden', !isHost);
        startBtn.disabled = !!state.started;
        startBtn.textContent = state.started ? '对局已开始' : '开始游戏';
      }
    },

    slotHTML(state, slot) {
      const s = (state.slots || [])[slot];
      const isMe = !!(s && s.peerId === this._myPeerId);
      const canMove = !state.started;
      if (!s) {
        return '<div class="room-slot empty' + (canMove ? ' can-move' : '') +
            '" data-slot="' + slot + '">' +
          '<div class="room-avatar placeholder"><span>＋</span></div>' +
          '<div class="room-slot-info"><div class="room-slot-nick">空位</div>' +
          '<div class="room-slot-tag">' +
            (canMove ? '点击换到此位置' : '开始后由 AI 补位') + '</div></div></div>';
      }
      const tags = [];
      if (s.host) tags.push('房主');
      if (isMe) tags.push('你');
      if (!s.host && !isMe) tags.push('玩家');
      // 换位置：自己的位置不可点，其余（空位 / 别人的位置）都可点
      const swap = (canMove && !isMe) ? ' can-move ask-swap' : '';
      return '<div class="room-slot' + (isMe ? ' me' : '') + (s.host ? ' host' : '') +
          swap + '" data-slot="' + slot + '">' +
        avatarHTML(s.avatar, s.nick) +
        '<div class="room-slot-info">' +
          '<div class="room-slot-nick">' + esc(s.nick || '玩家') + '</div>' +
          '<div class="room-slot-tag">' + tags.join(' · ') + '</div>' +
        '</div></div>';
    },

    /* ---------------- 换位置申请条 ---------------- */

    /** 显示「是否交换位置」确认条；onYes / onNo 由具体会话给出 */
    showAsk(text, onYes, onNo) {
      const bar = $('room-ask');
      if (!bar || !bar.classList) return;
      const t = $('room-ask-text');
      if (t) t.textContent = text || '';
      this._askYes = onYes || null;
      this._askNo = onNo || null;
      bar.classList.remove('hidden');
    },

    hideAsk() {
      const bar = $('room-ask');
      if (bar && bar.classList) bar.classList.add('hidden');
      this._askYes = null;
      this._askNo = null;
    },

    /* ---------------- 等候界面 + 队伍选将 ---------------- */

    /** 开始选将：把战斗界面清空（角色框留空），并压暗等待 */
    showPickBackdrop(ui, room) {
      const doc = global.document;
      if (!doc) return;
      ['start-screen', 'room-screen', 'mode-screen'].forEach((id) => {
        const e = $(id);
        if (e && e.classList) e.classList.add('hidden');
      });
      if (doc.body && doc.body.classList) doc.body.classList.add('room-picking');
      const set = (id, txt) => { const e = $(id); if (e) e.textContent = txt; };
      set('round-info', '房间 ' + (room || '') + ' · 正在选将');
      set('deck-info', '牌堆 160 张');
      set('hint', '');
      ['me-hand', 'table-card', 'actions', 'skill-actions', 'me-judge-marks',
        'me-equip-area', 'log'].forEach((id) => {
        const e = $(id);
        if (e && typeof e.innerHTML === 'string') e.innerHTML = '';
      });
    },

    openPick(data, handlers) {
      this.pickHandlers = handlers || {};
      if (!this.pickHandlers.artFor) this.pickHandlers.artFor = this.handlers.artFor;
      this._pick = data;
      this.probePickBg();
      const panel = $('team-pick');
      if (panel && panel.classList) panel.classList.remove('hidden');
      this.renderPick(data);
    },

    renderPick(data) {
      data = data || this._pick;
      if (!data || !data.chars) return;
      this._pick = data;
      const box = $('team-pick-cards');
      if (!box) return;
      const picks = data.picks || {};
      const mine = picks[data.mySeat] || null;
      const takenBy = {};
      Object.keys(picks).forEach((seat) => { takenBy[picks[seat]] = seat; });
      const chars = data.chars.map((id) => (SGS.Characters || {})[id]).filter(Boolean);
      // ★ 队伍选将卡＝局内同款角色框（立绘 / 势力 / 体力量 / 技能浮层）：
      //   复用 ui.pickHeroHTML()，与单机选将完全一致；框下方是选择按钮，
      //   已选 / 队友已选的状态在卡片上方打徽标、按钮置灰并写明原因。
      const heroOf = (c) => {
        if (this.handlers.heroHTML) {
          try { return this.handlers.heroHTML(c); } catch (e) { /* 回退 */ }
        }
        return '';
      };
      box.innerHTML = chars.map((c) => {
        const taker = takenBy[c.id];
        const isMine = taker != null && String(taker) === String(data.mySeat);
        const isTaken = taker != null && !isMine;
        const cls = 'pick-slot tp-hero-slot' + (isMine ? ' mine' : '') +
          (isTaken ? ' taken' : '');
        const label = isMine ? '已选择此将'
          : isTaken ? '队友已选' : '选择此将 <em>→</em>';
        let hero = heroOf(c);
        if (!hero) {
          // 极简环境兜底（无 ui 实例）：保持可辨识的名字 + 势力
          hero = '<div class="hero-card pick-hero" data-id="' + esc(c.id) + '">' +
            '<div class="hero-faction" data-faction="' + esc(c.faction || '群') + '">' +
              esc(c.faction || '群') + '</div>' +
            '<div class="hero-name">' + esc(c.displayName || c.name || c.id) + '</div>' +
            '</div>';
        }
        return '<div class="' + cls + '" data-id="' + esc(c.id) + '">' +
          '<div class="tp-hero-wrap">' + hero +
            (isMine ? '<div class="tp-badge">你已选</div>' : '') +
            (isTaken ? '<div class="tp-badge">队友已选</div>' : '') +
          '</div>' +
          '<button class="pick-btn tp-pick" data-id="' + esc(c.id) + '" type="button"' +
            ((isMine || isTaken) ? ' disabled' : '') + '>' + label + '</button>' +
        '</div>';
      }).join('');
      // ★ 与单机选将一致：悬停（CSS）或长按（bindHoldInfo）都能看角色介绍。
      //   卡片每次重绘都要重新绑定，事件监听不能留在旧节点上。
      try {
        const ui = this.handlers.ui;
        if (ui && typeof ui.bindHoldInfo === 'function' &&
            typeof box.querySelectorAll === 'function') {
          const heroes = box.querySelectorAll('.pick-hero');
          Array.prototype.forEach.call(heroes, (hero) => {
            if (hero && typeof hero.addEventListener === 'function' &&
                !hero.dataset.holdBound) {
              hero.dataset.holdBound = '1';
              ui.bindHoldInfo(hero, { group: () => heroes });
            }
          });
        }
      } catch (e) { /* 极简环境没有 DOM，忽略 */ }
      const picksInTeam = (data.seats || []).filter((s) => picks[s]).length;
      const sub = $('team-pick-sub');
      if (sub) {
        const short = data.chars.length < POOL_SIZE
          ? '（武将总数不足，自动缩减以保证两队不重复）' : '';
        sub.textContent = '队伍将池 ' + data.chars.length + ' 选 1 · ' +
          (data.team === 'A' ? '队伍一' : '队伍二') +
          ' · 本队已选 ' + picksInTeam + '/' + (data.seats || []).length +
          ' · 队内不可重复' + short;
      }
      const st = $('team-pick-status');
      if (st) {
        if (mine) st.textContent = '已选择 ' +
          ((SGS.Characters[mine] || {}).displayName || mine) + '，等待其他玩家…';
        else st.textContent = '点角色框下方按钮选择武将 · 悬停可看技能';
      }
    },

    closePick() {
      const panel = $('team-pick');
      if (panel && panel.classList) panel.classList.add('hidden');
      if (global.document && global.document.body && global.document.body.classList) {
        global.document.body.classList.remove('room-picking');
      }
      this._pick = null;
    },

    closeAll() {
      this.closePick();
      this.close();
    }
  };

  /* ================= 多远端路由（房主侧） ================= */
  const WAIT_INDEX = Net.WAIT_INDEX;
  const FX_METHODS = Net.FX_METHODS;

  class RoomRouterUI {
    constructor(localUI, remoteBySeat, broadcast) {
      this.localUI = localUI;
      this.remoteBySeat = remoteBySeat || {};
      const proto = (SGS.UI && SGS.UI.prototype) || {};
      Object.getOwnPropertyNames(proto).forEach((name) => {
        if (name === 'constructor' || WAIT_INDEX[name] != null) return;
        if (typeof proto[name] !== 'function') return;
        this[name] = function () {
          const fn = localUI[name];
          const r = typeof fn === 'function' ? fn.apply(localUI, arguments) : undefined;
          if (broadcast && FX_METHODS.indexOf(name) >= 0) {
            try { broadcast(name, Array.prototype.slice.call(arguments)); } catch (e) {}
          }
          return r;
        };
      });
      Object.keys(WAIT_INDEX).forEach((name) => {
        const idx = WAIT_INDEX[name];
        this[name] = function () {
          const decider = arguments[idx];
          const seat = decider && decider.seat;
          const ui = (decider && decider.isRemote && this.remoteBySeat[seat])
            ? this.remoteBySeat[seat] : localUI;
          const ret = ui[name].apply(ui, arguments);
          // ★ 2v2 联机读秒：房主替所有人播报「现在在问谁」
          //   （日志经 onLog 同步，红色描边走一条极小的座位帧）。
          //   放在派发之后：远端 ask 已先推快照，座位帧跟着新 current 走。
          try { localUI.noticeAsk(name, arguments, decider); } catch (e) {}
          return ret;
        };
      });
    }
    get wuguSession() { return this.localUI.wuguSession; }
    set wuguSession(v) { this.localUI.wuguSession = v; }
    get pending() { return this.localUI.pending; }
    set pending(v) { this.localUI.pending = v; }
    get game() { return this.localUI.game; }
    set game(v) { this.localUI.game = v; }
  }
  Net.RoomRouterUI = RoomRouterUI;

  /** 每台客机一个 RemoteUI；ask 帧带 to=seat，房主按座位定向发 */
  class PeerRemoteUI extends Net.RemoteUI {
    constructor(session, seat, peerId) {
      super(session);
      this.remoteSeat = seat;
      this.peerId = peerId;
    }
  }

  /* ================= 房主会话 ================= */
  class RoomHostSession {
    constructor(opts) {
      opts = opts || {};
      this.role = 'host';
      this.ui = opts.ui;
      this.cfg = opts.cfg || {};
      this.room = String(opts.room || '');
      this.onState = opts.onState || function () {};
      this.profile = {
        nick: opts.nick || Store.nick() || Store.randomNick(),
        avatar: opts.avatar || Store.avatar() || ''
      };
      Store.setNick(this.profile.nick);
      this.slots = new Array(SLOT_N).fill(null);
      this.randomTeams = false;
      this.started = false;
      this.game = null;
      this.pools = null;
      this.picks = {};
      this.assign = null;
      this.remoteBySeat = {};
      this._tx = 0;
      this._snapTimer = null;
      this._closed = false;

      this.sig = new Net.Signaling({
        brokerUrl: this.cfg.brokerUrl, appId: this.cfg.appId, room: this.room,
        // ★ 自建中继口令（frp 部署时可选）：1v1 / 2v2 用的是同一个 cfg
        username: this.cfg.username, password: this.cfg.password,
        role: 'host',
        WebSocketImpl: opts.WebSocketImpl,
        onState: (s, x) => this.onState('signal:' + s, x),
        onPresence: (m) => this.onPresence(m),
        onSignal: (t, d, f) => this.onSignal(t, d, f),
        onRelay: (f, from) => this.onRelay(f, from)
      });
      this.slots[0] = {
        slot: 0, peerId: this.sig.peerId, nick: this.profile.nick,
        avatar: this.profile.avatar, host: true
      };
      RoomUI.bind({
        ui: this.ui,
        onStart: () => this.startGame(),
        onLeave: () => this.leave(),
        onNick: (v) => this.updateProfile(v, this.profile.avatar),
        onAvatar: (v) => this.updateProfile(this.profile.nick, v),
        onRandomTeams: (v) => { this.randomTeams = !!v; this.broadcastRoom(); },
        // ★ 换位置：从「房主当前所在位置」出发（房主自己也可能先换到空位），
        //   点空位直接换；点别人的位置 -> 向那个人发交换申请。
        onSlotClick: (slot) => this.requestMove(this.hostSlot(), slot),
        artFor: (id) => ((this.ui && this.ui.art && this.ui.art.characters) || {})[id] || '',
        heroHTML: (c) => (this.ui && typeof this.ui.pickHeroHTML === 'function')
          ? this.ui.pickHeroHTML(c) : ''
      });
    }

    /** 房主当前所在的位置号（换位后不再是固定的 0 号位） */
    hostSlot() {
      const byPeer = (this.slots || []).findIndex(
        (s) => s && this.sig && s.peerId === this.sig.peerId);
      if (byPeer >= 0) return byPeer;
      const byFlag = (this.slots || []).findIndex((s) => s && s.host);
      return byFlag >= 0 ? byFlag : 0;
    }

    start() {
      this.sig.start();
      RoomUI.open({
        role: 'host', room: this.room,
        nick: this.profile.nick, avatar: this.profile.avatar
      });
      this.broadcastRoom();
      this.onState('room:open');
      return this;
    }

    roomState() {
      return {
        room: this.room,
        host: this.sig.peerId,
        randomTeams: !!this.randomTeams,
        started: !!this.started,
        slots: this.slots.map((s, i) => (s ? {
          slot: i, peerId: s.peerId, nick: s.nick, avatar: s.avatar || '',
          host: !!s.host
        } : null))
      };
    }

    broadcastRoom() {
      if (this._closed) return;
      RoomUI.render(this.roomState(), this.sig.peerId);
      if (!this.started) {
        const n = this.slots.filter(Boolean).length;
        RoomUI.setStatus('房间 ' + this.room + ' · 已加入 ' + n + '/4' +
          (n < 4 ? ' · 不足 4 人由 AI 补位' : ''), 'ok');
      }
      const state = this.roomState();
      this.slots.forEach((s) => {
        if (s && !s.host) this.relayTo(s.peerId, { t: 'room', state: state });
      });
    }

    relayTo(peerId, frame) {
      try { this.sig.sendRelay(frame, peerId); } catch (e) {}
    }

    slotByPeer(peerId) {
      return this.slots.find((s) => s && s.peerId === peerId) || null;
    }
    slotBySeat(seat) {
      const slot = this.assign ? this.assign.seatOfSlot.indexOf(Number(seat)) : -1;
      return slot >= 0 ? this.slots[slot] : null;
    }
    peerBySeat(seat) {
      const slot = this.assign ? this.assign.seatOfSlot.indexOf(Number(seat)) : -1;
      const s = slot >= 0 ? this.slots[slot] : null;
      return s && !s.host ? s : null;
    }

    onSignal(type, data, from) {
      if (type === 'hello') this.addGuest(from, data || {});
    }

    onPresence(m) {
      if (!m || m.type !== 'bye' || !m.peer) return;
      const slot = this.slotByPeer(m.peer);
      if (!slot) return;
      this.slots[slot.slot] = null;
      // ★ 局中掉线：把该座位交回本地 AI 接管，避免整局卡在一个等不到的动作上
      if (this.game && this.assign) {
        const seat = this.assign.seatOfSlot[slot.slot];
        const p = (this.game.players || []).find((x) => String(x.seat) === String(seat));
        if (p && p.isRemote) {
          p.isRemote = false;
          if (SGS.log) SGS.log(p.name + ' 掉线，由 AI 接管。', 'warn');
        }
      }
      this.broadcastRoom();
      this.onState('room:leave', { peer: m.peer });
    }

    addGuest(peerId, data) {
      if (this._closed) return;
      if (this.slotByPeer(peerId)) return;
      if (this.started) {
        this.relayTo(peerId, { t: 'kick', reason: '对局已经开始' });
        return;
      }
      let slot = -1;
      // ★ 从 0 号位开始找空位：房主换到别处后，0 号位可能才是空的那个
      for (let i = 0; i < SLOT_N; i++) if (!this.slots[i]) { slot = i; break; }
      if (slot < 0) { this.relayTo(peerId, { t: 'kick', reason: '房间已满' }); return; }
      this.slots[slot] = {
        slot: slot, peerId: peerId,
        nick: String(data.nick || '').slice(0, 8) || Store.randomNick(),
        avatar: data.avatar || '', host: false
      };
      this.relayTo(peerId, { t: 'welcome', slot: slot, room: this.room });
      this.broadcastRoom();
      this.onState('room:join', { slot: slot });
    }

    updateProfile(nick, avatar) {
      this.profile.nick = String(nick || '').slice(0, 8) || this.profile.nick;
      this.profile.avatar = avatar || '';
      Store.setNick(this.profile.nick);
      const slot = this.hostSlot();
      if (this.slots[slot]) {
        this.slots[slot].nick = this.profile.nick;
        this.slots[slot].avatar = this.profile.avatar;
      }
      this.broadcastRoom();
    }

    onRelay(frame, from) {
      if (!frame || !frame.t) return;
      const slot = this.slotByPeer(from);
      if (frame.t === 'profile') {
        if (!slot) return;
        slot.nick = String(frame.nick || '').slice(0, 8) || slot.nick;
        slot.avatar = frame.avatar || '';
        this.broadcastRoom();
        return;
      }
      if (frame.t === 'pick') {
        if (!slot) return;
        this.handlePick(slot.slot, frame.charId);
        return;
      }
      // ★ 换位置：客机点空位（直接换）或点别人的位置（房主代发交换申请）
      if (frame.t === 'move') {
        if (!slot) return;
        this.requestMove(slot.slot, Number(frame.slot));
        return;
      }
      // ★ 被申请方同意 / 拒绝：房主才是唯一权威，由它真正交换两个位置。
      //   from/to 一律以房主记录的申请为准（客机回传的只是「哪一条申请」）。
      if (frame.t === 'swap-ok' || frame.t === 'swap-no') {
        const req = this._swapReq;
        if (!req) return;
        this.resolveSwap(req.from, req.to, frame.t === 'swap-ok');
        return;
      }
      if (frame.t === 'act') {
        if (!slot || !this.assign) return;
        const seat = this.assign.seatOfSlot[slot.slot];
        const rui = seat != null ? this.remoteBySeat[seat] : null;
        if (rui) rui.onAct(frame.id, frame.value);
        return;
      }
    }

    /* ---------------- 换位置（房主权威） ---------------- */

    /** 真正交换（或单向移动）两个位置；to 为空位时 from 侧留空 */
    moveTo(fromSlot, toSlot) {
      if (this.started || this.game) return false;
      fromSlot = Number(fromSlot);
      toSlot = Number(toSlot);
      if (fromSlot === toSlot) return false;
      if (fromSlot < 0 || toSlot < 0 || fromSlot >= SLOT_N || toSlot >= SLOT_N) return false;
      const a = this.slots[fromSlot];
      const b = this.slots[toSlot];
      this.slots[toSlot] = a ? Object.assign({}, a, { slot: toSlot }) : null;
      this.slots[fromSlot] = b ? Object.assign({}, b, { slot: fromSlot }) : null;
      this._swapReq = null;
      this.broadcastRoom();
      RoomUI.hideAsk();
      return true;
    }

    /**
     * 发起换位：
     *   · 目标是空位 → 直接换过去
     *   · 目标是别人 → 向那个人发「交换位置申请」，对方同意才换
     *   · 目标是房主自己 → 房主本地弹确认条
     * ★ 无论走哪条路，都顺手给「发起人」回一条 pending 提示，
     *   否则点完「申请交换」后界面什么都不会发生，玩家会以为没点到。
     */
    requestMove(fromSlot, toSlot) {
      if (this.started || this.game) return false;
      fromSlot = Number(fromSlot);
      toSlot = Number(toSlot);
      if (isNaN(fromSlot) || isNaN(toSlot) || fromSlot === toSlot) return false;
      const me = this.slots[fromSlot];
      if (!me) return false;
      const target = this.slots[toSlot];
      if (!target) return this.moveTo(fromSlot, toSlot);
      // 同一时间只保留一条交换申请，避免两个人的申请互相覆盖
      if (this._swapReq) {
        RoomUI.setStatus('已有交换位置申请正在等待对方确认…', 'err');
        return false;
      }
      const myName = me.nick || '玩家';
      const notice = (peerId, text) => {
        if (peerId && peerId !== this.sig.peerId) {
          this.relayTo(peerId, { t: 'swap-res', pending: true, text: text });
        }
      };
      if (target.host) {
        // 房主自己是被申请方：本地确认
        RoomUI.showAsk((target.nick || '房主') + ' 想和你交换位置，同意吗？',
          () => this.moveTo(fromSlot, toSlot),
          () => {
            RoomUI.setStatus('已拒绝交换位置');
            if (me.peerId) this.relayTo(me.peerId, { t: 'swap-res', ok: false });
          });
        notice(me.peerId, '已向 ' + (target.nick || '房主') + ' 发出交换位置申请，等待对方确认…');
        return true;
      }
      this._swapReq = {
        from: fromSlot, to: toSlot, peer: target.peerId, requester: me.peerId
      };
      this.relayTo(target.peerId, {
        t: 'swap-req', from: fromSlot, to: toSlot, nick: myName
      });
      notice(me.peerId, '已向 ' + (target.nick || '队友') + ' 发出交换位置申请，等待对方确认…');
      RoomUI.setStatus('已向 ' + (target.nick || '队友') + ' 发出交换位置申请…', 'ok');
      return true;
    }

    /** 交换申请的结果（ok=true 时执行交换） */
    resolveSwap(fromSlot, targetSlot, ok) {
      if (this.started || this.game) return false;
      const req = this._swapReq;
      if (!req) return false;
      // ★ 以房主记录的申请为准（谁能申请、申请到哪个位置都由房主决定），
      //   不信任客机回传的 from/to，避免乱序帧把两个无关的人换掉。
      if (Number(fromSlot) !== req.from || Number(targetSlot) !== req.to) return false;
      const requester = this.slots[req.from];
      const target = this.slots[req.to];
      const tell = (slotInfo, text, okFlag) => {
        if (slotInfo && !slotInfo.host) {
          this.relayTo(slotInfo.peerId, { t: 'swap-res', ok: okFlag, text: text });
        }
      };
      if (!ok || !target) {
        this._swapReq = null;
        this.broadcastRoom();
        const text = (target && target.nick ? target.nick : '对方') + ' 拒绝了交换位置';
        tell(requester, text, false);
        tell(target, text, false);
        RoomUI.setStatus(text);
        return false;
      }
      const moved = this.moveTo(req.from, req.to);
      if (moved) {
        const text = '位置已交换';
        tell(requester, text, true);
        tell(target, text, true);
        RoomUI.setStatus(text, 'ok');
      }
      return moved;
    }

    /* ---------------- 开始：分队 / 座次 / 将池 ---------------- */

    startGame() {
      if (this.started) return false;
      this.started = true;
      const teamOfSlot = this.randomTeams
        ? (() => {
            const order = shuffle([0, 1, 2, 3]);
            const t = new Array(4);
            order.forEach((s, i) => { t[s] = i < 2 ? 'A' : 'B'; });
            return t;
          })()
        : TEAM_OF_SLOT.slice();
      const seatOfSlot = new Array(4).fill(0);
      ['A', 'B'].forEach((team) => {
        const slots = [0, 1, 2, 3].filter((i) => teamOfSlot[i] === team);
        const seats = shuffle(SEATS_OF_TEAM[team]);
        slots.forEach((s, i) => { seatOfSlot[s] = seats[i]; });
      });
      this.assign = { teamOfSlot: teamOfSlot, seatOfSlot: seatOfSlot };
      // ★ 每队 5 张将池，并保证两队不出现同一名武将（场上不会有两个张飞）。
      //   武将总数不足 10 时（目前只有 9 名）自动缩到 floor(n/2)，
      //   宁可「4 选 1」也不重复。
      const all = shuffle(charIds());
      const size = Math.max(2, Math.min(POOL_SIZE, Math.floor(all.length / 2)));
      this.pools = {
        A: all.slice(0, size),
        B: all.slice(size, size * 2)
      };
      this.picks = {};
      this.broadcastRoom();
      // 通知每台客机：你的座位 / 队伍
      this.slots.forEach((s) => {
        if (!s || s.host) return;
        const seat = seatOfSlot[s.slot];
        this.relayTo(s.peerId, {
          t: 'start', room: this.room, seat: seat,
          team: teamOfSlot[s.slot], seats: SEATS_OF_TEAM[teamOfSlot[s.slot]]
        });
      });
      this.pushPools();
      // 房主自己进选将
      RoomUI.showPickBackdrop(this.ui, this.room);
      this.openMyPick();
      this.onState('room:picking');
      return true;
    }

    seatsOfTeam(team) {
      if (!this.assign) return [];
      const out = [];
      for (let i = 0; i < 4; i++) {
        if (this.assign.teamOfSlot[i] === team) out.push(this.assign.seatOfSlot[i]);
      }
      return out;
    }

    poolFrame(team) {
      return {
        t: 'pool', team: team,
        chars: (this.pools[team] || []).slice(),
        seats: this.seatsOfTeam(team),
        picks: Object.assign({}, this.picks)
      };
    }

    /** 把「本队将池 + 已选」推给每台客机（同队两台各发一份，内容相同） */
    pushPools() {
      if (!this.assign) return;
      this.slots.forEach((s) => {
        if (!s || s.host) return;
        const team = this.assign.teamOfSlot[s.slot];
        this.relayTo(s.peerId, this.poolFrame(team));
      });
    }

    openMyPick() {
      const slot = this.hostSlot();
      const team = this.assign.teamOfSlot[slot];
      const mySeat = this.assign.seatOfSlot[slot];
      const data = Object.assign(this.poolFrame(team), { mySeat: mySeat });
      RoomUI.renderPick(data);
      RoomUI.openPick(data, { onPick: (id) => this.handlePick(slot, id) });
    }

    handlePick(slot, charId) {
      if (!this.assign || !this.started || this.game) return false;
      const slotInfo = this.slots[slot];
      if (!slotInfo) return false;
      const team = this.assign.teamOfSlot[slot];
      const seat = this.assign.seatOfSlot[slot];
      const pool = this.pools[team] || [];
      if (pool.indexOf(String(charId)) < 0) return false;
      const mates = this.seatsOfTeam(team);
      if (mates.some((s) => String(s) !== String(seat) &&
          String(this.picks[s]) === String(charId))) return false;
      this.picks[seat] = String(charId);
      this.pushPools();
      this.refreshPickUI();
      // 同队另一名人类也会通过 pool 帧刷新；房主自己的面板要重绘
      this.maybeFinishPicks();
      return true;
    }

    refreshPickUI() {
      if (!this.assign || this.game) return;
      const slot = this.hostSlot();
      const team = this.assign.teamOfSlot[slot];
      const mySeat = this.assign.seatOfSlot[slot];
      const data = Object.assign(this.poolFrame(team), { mySeat: mySeat });
      RoomUI.renderPick(data);
    }

    maybeFinishPicks() {
      if (this.game) return;
      const humans = [];
      for (let i = 0; i < 4; i++) {
        if (this.slots[i]) humans.push(this.assign.seatOfSlot[i]);
      }
      if (!humans.every((seat) => this.picks[seat])) return;
      // AI 补位：从本队剩余将池里取一张
      for (let i = 0; i < 4; i++) {
        if (this.slots[i]) continue;
        const team = this.assign.teamOfSlot[i];
        const seat = this.assign.seatOfSlot[i];
        const used = Object.keys(this.picks).map((k) => this.picks[k]);
        const avail = (this.pools[team] || []).filter((id) => used.indexOf(id) < 0);
        this.picks[seat] = avail[0] || (this.pools[team] || [])[0];
      }
      if (Object.keys(this.picks).length < 4) return;
      this.beginGame();
    }

    /* ---------------- 开局 ---------------- */

    beginGame() {
      const ui = this.ui;
      const seatOfSlot = this.assign.seatOfSlot;
      const hostSlot = this.hostSlot();
      const roster = [0, 1, 2, 3].map((slot) => {
        const seat = seatOfSlot[slot];
        const s = this.slots[slot];
        return {
          charId: this.picks[seat],
          seat: seat,
          isHuman: slot === hostSlot,
          isRemote: !!(s && !s.host),
          nickname: s ? s.nick : '电脑'
        };
      });
      const hostSeat = seatOfSlot[hostSlot];
      const hostChar = this.picks[hostSeat];
      this.remoteBySeat = {};
      roster.forEach((r) => {
        if (!r.isRemote) return;
        const slotIdx = seatOfSlot.indexOf(r.seat);
        const peer = this.slots[slotIdx];
        if (peer) this.remoteBySeat[r.seat] = new PeerRemoteUI(this, r.seat, peer.peerId);
      });
      const broadcast = Net.makeBroadcast(this);
      const router = new RoomRouterUI(ui, this.remoteBySeat, broadcast);
      const game = new SGS.Game(ui, hostChar, {
        mode: '2v2', roster: roster, uiRouter: router
      });
      this.game = game;
      this.remoteSeats = roster.filter((r) => r.isRemote).map((r) => r.seat);
      Object.keys(this.remoteBySeat).forEach((seat) => {
        this.remoteBySeat[seat].attach(this, game, Number(seat));
      });
      ui.bindGame(game);
      ui.vsAI = false;
      ui._netHost = true;
      // ★ 战斗 BGM：房间 / 选将阶段不播，真正建好对局（beginGame）才启动。
      //   自动播放被拦时由 Audio 层等下一次点击补播。
      try { if (SGS.Audio && SGS.Audio.startBgm) SGS.Audio.startBgm(); } catch (e) {}
      ui.onRender = () => this.pushSnapshot();
      ui.onLog = (m, c) => this.send({ t: 'log', m: m, c: c });
      // ★ 2v2 读秒：座位号 + 短标签 + 总秒数，客机据此点亮红框、走倒计时胶囊
      ui.onAskOwner = (info) => this.send({
        t: 'askOwner',
        seat: info ? info.seat : null,
        label: info ? info.label : '',
        secs: info ? info.secs : 0
      });
      RoomUI.closePick();
      this.sendInit();
      this.pushSnapshot(true);
      this.onState('game:start');
      const self = this;
      game.run().then(() => self.sendOver()).catch(() => {});
    }

    /**
     * 对局结束：按阵营给每台客机下发各自的胜负。
     * ★ 2v2 绝不能拿房主的阵营去反推客机 —— 队友与对手的胜负是相反的。
     *   wipedTeam() 返回「仍存活」的阵营，座位阵营与之一致才算赢。
     */
    sendOver() {
      const game = this.game;
      if (!game) return;
      const winTeam = game.wipedTeam ? game.wipedTeam() : null;
      this.recipientSeats().forEach((seat) => {
        const p = (game.players || []).find((x) => String(x.seat) === String(seat));
        const win = !!(p && winTeam && p.team === winTeam);
        this.send({ t: 'over', to: seat, win: win });
      });
    }

    sendInit() {
      if (!this.game) return;
      this.remoteSeats.forEach((seat) => {
        this.send({
          t: 'init', to: seat, seat: seat,
          hostCharId: this.game.human && this.game.human.char.id
        });
      });
    }

    recipientSeats() {
      return (this.remoteSeats || []).slice();
    }

    /** 按 frame.to（座位）定向；没有 to 就发给所有客机 */
    send(frame) {
      if (!frame) return;
      const to = frame.to;
      if (to != null) {
        const peer = this.peerBySeat(to);
        if (peer) this.relayTo(peer.peerId, frame);
        return;
      }
      this.slots.forEach((s) => {
        if (s && !s.host) this.relayTo(s.peerId, frame);
      });
    }

    pushSnapshot(immediate) {
      if (!this.game) return;
      const emit = () => {
        this._snapTimer = null;
        this.recipientSeats().forEach((seat) => {
          this.send({ t: 'snap', tx: this._tx, to: seat,
            snap: P.makeSnapshot(this.game, seat) });
        });
      };
      if (this._snapTimer) clearTimeout(this._snapTimer);
      // 公共 broker：快照合并得粗一点，避免一次动画连发几十条
      if (immediate) emit();
      // 四台机器共用公共 broker：多客机时把渲染驱动的快照再放宽一点
      else this._snapTimer = setTimeout(emit,
        this.recipientSeats().length > 1 ? 160 : 120);
    }

    /* ---------------- 收尾 ---------------- */

    leave() {
      this.close();
      if (global.document && global.document.getElementById) {
        const start = global.document.getElementById('start-screen');
        if (start && start.classList) start.classList.remove('hidden');
      }
    }

    close() {
      if (this._closed) return;
      // 先通知客机（房主离开后客机不会一直卡在等帧上）
      this.slots.forEach((s) => {
        if (s && !s.host) this.relayTo(s.peerId, { t: 'kick', reason: '房主已离开房间' });
      });
      this._closed = true;
      if (this._snapTimer) clearTimeout(this._snapTimer);
      try { this.sig.close(); } catch (e) {}
      if (this.ui) {
        this.ui.onRender = null;
        this.ui.onLog = null;
        this.ui.onAskOwner = null;
        this.ui._netHost = false;
      }
      RoomUI.closeAll();
    }
  }
  Net.RoomHostSession = RoomHostSession;

  /* ================= 客机会话 ================= */
  class RoomGuestSession extends Net.GuestSession {
    constructor(opts) {
      opts = opts || {};
      const profile = {
        nick: opts.nick || Store.nick() || Store.randomNick(),
        avatar: opts.avatar || Store.avatar() || ''
      };
      Store.setNick(profile.nick);
      super({
        ui: opts.ui, cfg: opts.cfg, room: opts.room, role: 'guest',
        helloExtra: { nick: profile.nick, avatar: profile.avatar },
        WebSocketImpl: opts.WebSocketImpl,
        onState: opts.onState
      });
      this.profile = profile;
      this._forceRelay = true;
      this._relayMode = true;          // 星形中继：游戏帧一律走 broker
      this.mySlot = null;
      this.mySeat = null;
      this.myTeam = null;
      this.remoteSeat = null;
      this._lastRoom = null;
      RoomUI.bind({
        ui: this.ui,
        onLeave: () => this.leave(),
        onNick: (v) => this.updateProfile(v, this.profile.avatar),
        onAvatar: (v) => this.updateProfile(this.profile.nick, v),
        // 客机：点位置只上送请求，真正的交换 / 移动由房主决定
        onSlotClick: (slot) => this.send({ t: 'move', slot: slot }),
        artFor: (id) => ((this.ui && this.ui.art && this.ui.art.characters) || {})[id] || '',
        heroHTML: (c) => (this.ui && typeof this.ui.pickHeroHTML === 'function')
          ? this.ui.pickHeroHTML(c) : ''
      });
    }

    start() {
      this.sig.start();
      RoomUI.open({
        role: 'guest', room: this.room,
        nick: this.profile.nick, avatar: this.profile.avatar
      });
      this.onState('room:open');
      return this;
    }

    /** 所有上送都经 broker 发给房主（2v2 没有 PeerConnection） */
    send(frame) {
      if (!this.sig || !this.sig.hostPeerId) return;
      try { this.sig.sendRelay(frame, this.sig.hostPeerId); } catch (e) {}
    }

    /** 房间模式永远在中继上，不需要「切换」流程 */
    useRelay() { return false; }
    _resyncAfterRelay() {}
    _startHeartbeat() {}

    updateProfile(nick, avatar) {
      this.profile.nick = String(nick || '').slice(0, 8) || this.profile.nick;
      this.profile.avatar = avatar || this.profile.avatar;
      Store.setNick(this.profile.nick);
      RoomUI.setProfile(this.profile.nick, this.profile.avatar);
      if (this.sig) this.sig.helloExtra = this.profile;
      this.send({ t: 'profile', nick: this.profile.nick, avatar: this.profile.avatar });
    }

    onRoomFrame(m) {
      if (!m || !m.t) return false;
      switch (m.t) {
        case 'room':
          this._lastRoom = m.state;
          // 位置可能被房主调整过（换位置 / 有人加入离开）→ 同步自己的位置号
          if (m.state && Array.isArray(m.state.slots)) {
            const idx = m.state.slots.findIndex((s) =>
              s && s.peerId === (this.sig && this.sig.peerId));
            if (idx >= 0) this.mySlot = idx;
          }
          RoomUI.render(m.state, this.sig.peerId);
          RoomUI.setStatus(m.state && m.state.started
            ? '选将中…' : '已加入房间，等待房主开始游戏', 'ok');
          return true;
        // ★ 有人想和我换位置：弹确认条，同意后由房主真正交换
        case 'swap-req':
          RoomUI.showAsk((m.nick || '队友') + ' 想和你交换位置（' +
            (m.from != null ? '对方 ' + (Number(m.from) + 1) + ' 号位' : '') + '），同意吗？',
            () => this.send({ t: 'swap-ok', from: m.from }),
            () => this.send({ t: 'swap-no', from: m.from }));
          return true;
        case 'swap-res':
          // pending = 房主已收到申请、正在等对方确认（给发起人吃颗定心丸）
          if (m.pending) {
            RoomUI.setStatus(m.text || '交换位置申请已发出，等待对方确认…', 'ok');
          } else {
            RoomUI.setStatus(m.text || (m.ok ? '位置已交换' : '对方拒绝了交换位置'),
              m.ok ? 'ok' : '');
          }
          return true;
        case 'welcome':
          this.mySlot = m.slot;
          this.onState('room:joined');
          return true;
        case 'start':
          this.mySeat = m.seat;
          this.myTeam = m.team;
          this.remoteSeat = m.seat;
          RoomUI.showPickBackdrop(this.ui, this.room);
          return true;
        case 'pool':
          this._pool = m;
          RoomUI.openPick(Object.assign({}, m, { mySeat: this.mySeat }),
            { onPick: (id) => this.send({ t: 'pick', charId: id }) });
          return true;
        case 'kick':
          RoomUI.setStatus('无法加入：' + (m.reason || '房间已满'), 'err');
          return true;
        default:
          return false;
      }
    }

    onInit(m) {
      super.onInit(m);
      RoomUI.closeAll();
      this.onState('game:init');
    }

    onOver(m) {
      try { this.ui.showGameOver(!!(m && m.win), this.viewGame); } catch (e) {}
      this.onState('game:over');
    }

    leave() {
      this.close();
      if (global.document && global.document.getElementById) {
        const start = global.document.getElementById('start-screen');
        if (start && start.classList) start.classList.remove('hidden');
      }
    }

    close() {
      RoomUI.closeAll();
      if (this.ui) this.ui._netView = false;   // 回到单机时恢复普通渲染
      super.close();
    }
  }
  Net.RoomGuestSession = RoomGuestSession;

  /* ================= 工厂 ================= */
  Net.createRoom = function (role, opts) {
    const C = role === 'host' ? RoomHostSession : RoomGuestSession;
    return new C(opts || {});
  };

  /** 纯函数：分队 / 座次（自测用） */
  Net.Room = {
    TEAM_OF_SLOT: TEAM_OF_SLOT,
    SEATS_OF_TEAM: SEATS_OF_TEAM,
    POOL_SIZE: POOL_SIZE,
    shuffle: shuffle,
    assign(teamOfSlot) {
      const seatOfSlot = new Array(4).fill(0);
      ['A', 'B'].forEach((team) => {
        const slots = [0, 1, 2, 3].filter((i) => teamOfSlot[i] === team);
        const seats = shuffle(SEATS_OF_TEAM[team]);
        slots.forEach((s, i) => { seatOfSlot[s] = seats[i]; });
      });
      return seatOfSlot;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
