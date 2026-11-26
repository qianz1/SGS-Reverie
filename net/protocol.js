/**
 * net/protocol.js — 联机消息协议：远程 UI 参数打包 / 回传值解包 / 权威快照
 *
 * 设计核心（这是「主机权威」能做到最小侵入的关键）：
 *
 *   1) 主机不把「规则」发给客机，只把「该远端玩家做一次决策」转发出去。
 *      转发的是 UI 方法名 + waitXXX 的原始参数，参数里的 Player / Card /
 *      Game / filter 函数统一打包成可 JSON 化的描述。客机收到后调用自己
 *      的真实 SGS.UI[method](...)，于是全部界面（选牌 / 目标 / 五谷 /
 *      火计看牌 / 无懈…）原样复用，一行界面代码都不用重写。
 *
 *   2) 客机点完确认后，把 finish() 的值回传。主机按牌 id / 座位号还原成
 *      自己内存里的**真对象**再交给规则层，所以规则层完全不知道有网络。
 *
 *   3) 隐藏信息：主机下发的快照按「客机座位」裁剪 —— 客机看得到自己的
 *      全部手牌，对手手牌只给张数；牌堆顺序、判定牌内容从不外发。
 *      这也是选「主机权威」而不是「双端重放」的主要理由。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Net = SGS.Net || (SGS.Net = {});
  const P = Net.Protocol || (Net.Protocol = {});

  P.VERSION = 1;

  function isGame(v) { return !!(v && v.players && v.deck && typeof v.runTurn === 'function'); }
  function isPlayer(v) { return !!(v && v.char && Array.isArray(v.hand) && v.equips); }
  function isCard(v) { return !!(v && v.id != null && v.type != null && !isPlayer(v)); }

  /** 列出某个座位当前「看得见」的全部牌，供 filter 函数求值与回传解包 */
  P.visibleCards = function (game, seat) {
    const map = {};
    const add = (c) => { if (c && c.id != null) map[c.id] = c; };
    (game.players || []).forEach((p) => {
      if (p.seat === seat) (p.hand || []).forEach(add);
      (p.equips ? Object.keys(p.equips) : []).forEach((k) => add(p.equips[k]));
      (p.delayed || []).forEach(add);
    });
    (game.showcase || []).forEach(add);
    if (game.ui && game.ui.wuguSession) (game.ui.wuguSession.cards || []).forEach(add);
    return map;
  };

  /** 在真实 Game 里按 id 找回同一张牌对象（规则层会做引用比较） */
  P.findCard = function (game, id) {
    if (!game || id == null) return null;
    const zones = [];
    (game.players || []).forEach((p) => {
      zones.push(p.hand || [], p.delayed || []);
      if (p.equips) Object.keys(p.equips).forEach((k) => { if (p.equips[k]) zones.push([p.equips[k]]); });
    });
    if (game.deck) {
      zones.push(game.deck.cards || [], game.deck.discardPile || []);
    }
    if (game.showcase) zones.push(game.showcase);
    if (game.ui && game.ui.wuguSession) zones.push(game.ui.wuguSession.cards || []);
    for (const z of zones) {
      for (const c of z) if (c && String(c.id) === String(id)) return c;
    }
    return null;
  };

  P.findPlayer = function (game, seat) {
    return (game.players || []).find((p) => String(p.seat) === String(seat)) || null;
  };

  /* ---------------- 主机 → 客机：ask 参数打包 ---------------- */
  /**
   * @param {Array} args waitXXX 的原始参数
   * @param {Game} game 权威 Game（用于对 filter 函数求值）
   * @param {number} viewerSeat 收信方座位
   */
  P.packArgs = function (args, game, viewerSeat) {
    const pool = P.visibleCards(game, viewerSeat);
    const ids = Object.keys(pool);
    // ★ 只用「当前递归路径」防环，不能用全局 seen 去重：
    //   ask 的第一个参数 user 往往同时出现在 targets 里（火攻 / 三陈 /
    //   铁索都可以指定自己）。用全局 seen 时第二次遇到同一个角色会写成
    //   null，客机解包后目标列表里自己变成 null → 点自己的角色框被判定为
    //   「不是合法目标」，就是「客机三陈选不了自己」的根因。
    const path = [];

    function walk(v) {
      if (v == null || typeof v === 'number' || typeof v === 'boolean' ||
          typeof v === 'string') return v;
      if (typeof v === 'function') {
        // 把「哪些牌可点」求值成 id 白名单，避免序列化函数
        const allow = [];
        ids.forEach((id) => {
          try { if (v(pool[id])) allow.push(id); } catch (e) {}
        });
        return { __t: 'fn', allow: allow };
      }
      if (path.indexOf(v) >= 0) return null;   // 真正的环形引用
      // 叶子对象（Game / 角色 / 牌）不会继续递归，不需要进出栈
      if (isGame(v)) return { __t: 'game' };
      if (isPlayer(v)) return { __t: 'p', seat: v.seat };
      if (isCard(v)) return { __t: 'c', card: plainCard(v) };
      path.push(v);
      let out;
      if (Array.isArray(v)) {
        out = v.map(walk);
      } else {
        out = {};
        Object.keys(v).forEach((k) => {
          if (k === 'resolve' || k === 'game') return;  // 不传内部字段
          out[k] = walk(v[k]);
        });
      }
      path.pop();
      return out;
    }
    return (args || []).map(walk);
  };

  /** Card 是纯数据对象，逐字段拷一份（去掉可能的循环引用） */
  function plainCard(c) {
    return {
      id: c.id, type: c.type, name: c.name, suit: c.suit, rank: c.rank,
      color: c.color, category: c.category, image: c.image || null,
      mark: c.mark || null
    };
  }
  P.plainCard = plainCard;

  /* ---------------- 客机：解包 ask 参数 ---------------- */
  P.unpackArgs = function (packed, viewGame) {
    const pool = P.visibleCards(viewGame, viewGame.viewerSeat);
    function walk(v) {
      if (!v || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(walk);
      switch (v.__t) {
        case 'game': return viewGame;
        case 'p': return P.findPlayer(viewGame, v.seat);
        case 'c': {
          const real = pool[v.card && v.card.id];
          if (real) return real;
          // 目标手牌 / 五谷亮牌等不在自己牌池里：用数据造一个可显示对象
          const c = Object.assign({}, v.card || {});
          c.name = c.name || (SGS.Cards && SGS.Cards.nameOf ? SGS.Cards.nameOf(c.type) : c.type);
          return c;
        }
        case 'fn': {
          const allow = v.allow || [];
          return (c) => !!c && allow.indexOf(c.id) >= 0;
        }
        default: {
          const out = {};
          Object.keys(v).forEach((k) => { out[k] = walk(v[k]); });
          return out;
        }
      }
    }
    return (packed || []).map(walk);
  };

  /* ---------------- 客机 → 主机：回传值打包 / 解包 ---------------- */
  P.packAct = function (value) {
    function walk(v) {
      if (v == null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(walk);
      if (isPlayer(v)) return { __t: 'p', seat: v.seat };
      if (isCard(v)) return { __t: 'c', id: v.id };
      const out = {};
      Object.keys(v).forEach((k) => { out[k] = walk(v[k]); });
      return out;
    }
    return walk(value);
  };

  P.unpackAct = function (value, game) {
    function walk(v) {
      if (!v || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(walk);
      if (v.__t === 'p') return P.findPlayer(game, v.seat);
      if (v.__t === 'c') return P.findCard(game, v.id) || v;
      const out = {};
      Object.keys(v).forEach((k) => { out[k] = walk(v[k]); });
      return out;
    }
    return walk(value);
  };

  /* ---------------- 主机 → 客机：表现层事件（飞牌 / 受击 / 面板） ---------------- */
  /**
   * ★ 为什么要单独一套 packFxArgs，而不复用 packArgs：
   *   packArgs 会把函数「求值成 id 白名单」，但表现层 opts 里的 onArrive
  *   是「把牌 push 进手牌」的闭包，一旦被遍历求值就会在主机上真的改状态。
   *   所以这里把所有函数 / DOM 节点 / 布局矩形直接丢掉，只留纯数据。
   */
  function isDomLike(v) {
    return !!(v && (v.nodeType != null || v.nodeName != null ||
      (v.classList && v.style && typeof v.appendChild === 'function')));
  }
  P.packFxArgs = function (args, game, viewerSeat) {
    function walk(v, depth) {
      if (v == null || typeof v === 'number' || typeof v === 'boolean' ||
          typeof v === 'string') return v;
      if (typeof v === 'function' || isDomLike(v)) return null;
      if (depth > 8) return null;
      if (isGame(v)) return { __t: 'game' };
      if (isPlayer(v)) return { __t: 'p', seat: v.seat };
      if (isCard(v)) return { __t: 'c', card: plainCard(v) };
      // 布局矩形（{left,top,width,height}）不该跨端
      if (v.left != null && v.top != null && v.width != null &&
          !v.id && !v.type) return null;
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      const out = {};
      Object.keys(v).forEach((k) => {
        if (k === 'onArrive' || k === 'committedItem' || k === 'targetRect' ||
            k === 'resolve' || k === 'game') return;
        out[k] = walk(v[k], depth + 1);
      });
      return out;
    }
    return (args || []).map((a) => walk(a, 0));
  };

  /** 把一张实体牌换成牌背（对手摸牌 / 暗手牌被牵，绝不外泄牌面） */
  P.backCard = function (c) {
    return { id: c && c.id != null ? c.id : ('__back_' + Math.random().toString(36).slice(2, 8)),
      type: 'back', name: '牌背', suit: '', rank: '', color: 'black',
      category: 'hidden', image: null, mark: null };
  };
  P.hideCardFaces = function (arg) {
    if (Array.isArray(arg)) return arg.map((c) => P.backCard(c));
    return P.backCard(arg);
  };

  /**
   * ★★ 「谁能看到这张牌的正面」——全局唯一判据（绝对判断）。
   *
   *   规则（主公需求）：只有【牌的提供者】和【获得者】能看到正面，
   *   场上其他任何人都只能看到牌背。
   *   · 摸牌 / 判定这类「牌来自牌堆」的场合没有提供者，于是只有获得者能看。
   *   · 例外：这张牌本身就是【全场公开】的（五谷丰登亮出的牌、装备区 /
   *     判定区的明牌）→ 所有人都看正面。公开牌再藏牌背反而是错的。
   *
   *   为什么必须是座位号比对：任何「谁是 human / 谁是 aiPlayer」的判断都
   *   隐含 1 主机 1 客机，多人局里第三、第四个玩家会被错判成「对手」而
   *   白看牌面（或反过来自己被当对手，明明自己拿的牌却显示牌背）。
   *   座位号是全局唯一的，跟视角、人数、谁是房主都无关。
   *
   * @param {number|string} viewerSeat   收件人（要看牌的那位）的座位号
   * @param {number|string} providerSeat 牌的提供者座位号（来自牌堆时传 null）
   * @param {number|string} receiverSeat 牌的获得者座位号（亮牌 / 弃牌时传 null）
   * @param {boolean} publicFace         这张牌是否全场公开（默认 false）
   * @returns {boolean} 该收件人能否看到正面
   */
  P.canSeeFxFace = function (viewerSeat, providerSeat, receiverSeat, publicFace) {
    if (viewerSeat == null || viewerSeat === '') return false;
    // ★ 公开牌：人人看正面（座位号仍然必须已知，未知就按保守方向处理）
    if (publicFace) return true;
    const v = String(viewerSeat);
    const hit = (s) => s != null && s !== '' && String(s) === v;
    return hit(receiverSeat) || hit(providerSeat);
  };

  /**
   * ★ 从一次表现层调用里提炼「提供者 / 获得者」的座位号。
   *   主机广播、客机重放、测试都走这一个函数，保证两端口径完全一致。
   *
   * @param {string} name  表现层方法名（flyCard / flyCards / animateDraw / 其它）
   * @param {Array}  args  原始参数数组
   * @param {object} ctx   { localSeat, remoteSeats:[seat…] } 仅用于兼容旧调用：
   *                       没显式传 opts.toPlayer 时，按主机屏幕上的落点
   *                       'hand'(本机获得) / 'ai-hero'(远端获得) 还原获得者。
   * @returns {{providerSeat:number|null, receiverSeat:number|null, publicFace:boolean}}
   */
  P.fxFaceSeats = function (name, args, ctx) {
    ctx = ctx || {};
    const a = args || [];
    const seatOf = (p) => (p && p.seat != null) ? p.seat : null;
    const out = { providerSeat: null, receiverSeat: null, publicFace: false };
    // 摸牌：牌从牌堆来 → 没有提供者，只有获得者
    if (name === 'animateDraw') {
      out.receiverSeat = seatOf(a[1]);
      return out;
    }
    if (name !== 'flyCard' && name !== 'flyCards') return out;
    const opts = (a[2] && typeof a[2] === 'object' && !Array.isArray(a[2])) ? a[2] : {};
    const dest = opts.dest || 'showcase';
    // ★ 亮牌 / 弃置 / 装备 / 被拆被拆（过河拆桥）这类飞牌没有「获得者」，
    //   压根不是获得牌，不参与「提供者 / 获得者 / 公开」三态判定，
    //   正反面照旧由 opts.faceDown 决定（展示区本来就是公开亮牌）。
    if (dest !== 'hand' && dest !== 'ai-hero') return out;
    // ★ 全场公开的获得牌（五谷亮出的牌 / 装备区·判定区明牌被牵走）：
    //   人人看正面。只对「进手牌」的飞牌有意义，所以放在这道门之后。
    out.publicFace = !!opts.public;
    out.providerSeat = seatOf(a[1]);
    if (seatOf(opts.toPlayer) != null) {
      out.receiverSeat = seatOf(opts.toPlayer);
      return out;
    }
    // 兼容旧调用：调用方没给 toPlayer 时按落点还原（1v1 语境下的历史行为）
    if (dest === 'hand') out.receiverSeat = ctx.localSeat != null ? ctx.localSeat : null;
    else {
      const rs = ctx.remoteSeats || (ctx.remoteSeat != null ? [ctx.remoteSeat] : []);
      out.receiverSeat = rs.length === 1 ? rs[0] : null;
    }
    return out;
  };

  /**
   * ★ 视角翻转：主机算的 dest 是「主机屏幕上的落点」——
   *   'hand' = 主机自己收牌（客机是对手，只能看牌背飞向对手框），
   *   'ai-hero' = 远端（客机）收牌（客机屏幕上是我方手牌，应正面显示真牌面）。
   *
   * hide 由主机按「客机有没有权看这张牌」算好随帧下发：
   *   hide=true  → 牌面根本没下发（只有牌背占位），客机统一显示牌背、落点
   *                固定为对手框，绝不翻转成自己的手牌区。
   *   hide=false → 客机自己收牌 / 公开亮牌，按镜像翻转，正面朝上。
   * 两种情况都清掉 onArrive：客机状态只由权威快照决定。
   *
   * ★★ 这里曾有一个隐藏很深的烈性 bug：旧版对 args 做「全量递归」，
   *   animateDraw 的第 3 个参数是 Game（unpack 后就是 viewGame），而
   *   viewGame.ui === 真实 UI、UI.game === viewGame 构成环 —— 递归直接
   *   栈溢出，异常被 transport 的 try/catch 静默吞掉，表现就是「客机
   *   完全没有摸牌动画（自己的和对方的都没有）」，而飞牌类帧的 args[2]
   *   是普通 opts 不受影响，所以只有摸牌中招。
   *   现在只识别并翻转「opts 形状」的对象，Game / Player / 纯数据一律不深入。
   */
  P.unpackFxArgs = function (packed, viewGame, mySeat, hide) {
    const args = P.unpackArgs(packed, viewGame);
    const seen = new WeakSet();
    function isOptsLike(o) {
      return !!o && typeof o === 'object' && !Array.isArray(o) &&
        !isGame(o) && !isPlayer(o) && !isDomLike(o) &&
        ('dest' in o || 'faceDown' in o || 'onArrive' in o || 'toPlayer' in o);
    }
    function flip(v) {
      if (!v || typeof v !== 'object') return v;
      if (seen.has(v)) return v;
      seen.add(v);
      if (Array.isArray(v)) { v.forEach(flip); return v; }
      if (!isOptsLike(v)) return v;      // Game / Player / UI / 纯数据：绝不深入
      if (v.dest === 'hand' || v.dest === 'ai-hero') {
        if (hide) {
          v.dest = 'ai-hero';
          v.faceDown = true;
          v.onArrive = null;
        } else {
          v.dest = v.dest === 'hand' ? 'ai-hero' : 'hand';
          if (v.dest === 'hand') { v.faceDown = false; v.onArrive = null; }
        }
      }
      return v;
    }
    args.forEach(flip);
    return args;
  };

  /* ---------------- 主机 → 客机：按座位裁剪的权威快照 ---------------- */
  /**
   * 只发「客机应该看见的」：自己的手牌全量，对手手牌仅张数。
   * 牌堆顺序（deck.cards）、未亮出的判定牌一律不下发。
   */
  P.makeSnapshot = function (game, viewerSeat, extra) {
    const players = (game.players || []).map((p) => ({
      seat: p.seat,
      charId: p.char && p.char.id,
      name: p.name,
      hp: p.hp, maxHp: p.maxHp,
      chained: !!p.chained,
      flipped: !!p.flipped,   // 武将牌背面朝上（翻面）：客机角色框同样盖牌背
      // 回合内状态：客机的按钮置灰 / 技能栏要靠这些字段
      shaUsed: p.shaUsed || 0, jiuUsed: !!p.jiuUsed,
      jianyingUsed: !!p.jianyingUsed,
      jianmieUsed: !!p.jianmieUsed,
      sanchenUsed: !!p.sanchenUsed,
      sanchenNoTarget: !!p.sanchenNoTarget,
      pozhuDisabled: !!p.pozhuDisabled,
      trickUsedThisTurn: !!p.trickUsedThisTurn,
      // ★ 涅槃等局中获得的技能 / 已用掉的一次性技能：客机按钮与技能栏要同步
      skills: (p.acquiredSkills || []).slice(),
      usedSkillActions: Object.assign({}, p.usedSkillActions || {}),
      playLogCount: (p.playLog || []).length,
      equips: equipData(p),
      delayed: (p.delayed || []).map(plainCard),
      handCount: (p.hand || []).length,
      // ★ 对手手牌只给「真实 id + 牌背」，牌面一律不下发。
      //   为什么仍要真 id：顺手牵羊 / 过河拆桥选的是目标牌区里的一张牌，
      //   回传的 id 必须能在权威端还原成同一张真牌；而客机拿到 id 也
      //   看不到牌面（牌背），所以不构成信息泄露。
      handIds: (p.hand || []).map((c) => c.id),
      hand: String(p.seat) === String(viewerSeat)
        ? (p.hand || []).map(plainCard) : []
    }));
    const wugu = game.ui && game.ui.wuguSession
      ? {
          cards: (game.ui.wuguSession.cards || []).map(plainCard),
          taken: Object.assign({}, game.ui.wuguSession.taken || {}),
          turn: game.ui.wuguSession.turn || null
        }
      : null;
    return {
      v: P.VERSION,
      t: 'snap',
      viewerSeat: viewerSeat,
      players: players,
      deckRemaining: game.deck ? game.deck.remaining : 0,
      discardCount: game.deck ? (game.deck.discardPile || []).length : 0,
      showcase: (game.showcase || []).map(plainCard),
      phase: game.phase, round: game.round, current: game.current,
      actorSeat: game.actor ? game.actor.seat : null,
      over: !!game.over,
      wugu: wugu,
      vsAI: false,
      extra: extra || null
    };
  };

  function equipData(p) {
    const out = {};
    Object.keys(p.equips || {}).forEach((k) => {
      out[k] = p.equips[k] ? plainCard(p.equips[k]) : null;
    });
    return out;
  }

  /**
   * 客机把快照应用到一个「视图 Game」上。
   * 视图对象用 Object.create(原型) 造，保留 canPlaySha() / hook() 等方法，
   * 只是不跑规则、不持有真实牌堆 —— 因此 ui.render(viewGame) 可以直接用。
   */
  P.applySnapshot = function (viewGame, snap) {
    if (!viewGame || !snap) return viewGame;
    const meSeat = snap.viewerSeat;
    const bySeat = {};
    (snap.players || []).forEach((d) => { bySeat[d.seat] = d; });

    const list = (snap.players || []).map((d) => {
      let p = (viewGame.players || []).find((x) => String(x.seat) === String(d.seat));
      if (!p) {
        p = Object.create(SGS.Player.prototype);
        p.seat = d.seat;
      }
      const ch = (SGS.Characters || {})[d.charId] || Object.keys(SGS.Characters || {})[0];
      p.char = (SGS.Characters || {})[d.charId] || null;
      if (!p.char) {
        // 极端兜底：造一个最小角色对象，保证 UI 不抛
        p.char = { id: d.charId, name: d.name || '?', faction: '群', maxHp: d.maxHp,
                   skill: {}, displayName: d.name, introName: d.name };
      }
      p.name = d.name || p.char.name;
      p.isHuman = String(d.seat) === String(meSeat);   // UI 用它判断「你的回合」
      p.isRemote = !p.isHuman;
      p.maxHp = d.maxHp; p.hp = d.hp;
      p.chained = !!d.chained;
      p.flipped = !!d.flipped;
      p.shaUsed = d.shaUsed || 0; p.jiuUsed = !!d.jiuUsed;
      p.jianyingUsed = !!d.jianyingUsed;
      p.jianmieUsed = !!d.jianmieUsed;
      p.sanchenUsed = !!d.sanchenUsed;
      p.sanchenNoTarget = !!d.sanchenNoTarget;
      p.pozhuDisabled = !!d.pozhuDisabled;
      p.trickUsedThisTurn = !!d.trickUsedThisTurn;
      // 重建本玩家的技能视图：char.skill 不共享，避免污染另一个座位
      p.acquiredSkills = [];
      p._skillView = null;
      p.usedSkillActions = Object.assign({}, d.usedSkillActions || {});
      (d.skills || []).forEach((n) => {
        if (typeof p.acquireSkill === 'function') p.acquireSkill(n);
      });
      p.playLog = new Array(d.playLogCount || 0).fill(null)
        .map((_, i) => viewGame._fakePlayLog ? viewGame._fakePlayLog[i] : { card: null });
      p.equips = {};
      Object.keys(d.equips || {}).forEach((k) => { p.equips[k] = d.equips[k]; });
      p.delayed = (d.delayed || []).slice();
      p.hand = (d.hand || []).slice();
      // 对手手牌：牌背占位，但 id 是真的（供选牌回传还原，牌面仍不可见）
      if (String(d.seat) !== String(meSeat)) {
        const ids = d.handIds || [];
        p.hand = new Array(d.handCount || 0).fill(null)
          .map((_, i) => ({ id: ids[i] != null ? ids[i] : ('__hidden_' + d.seat + '_' + i),
                            type: 'back', name: '牌背', suit: '', rank: '',
                            color: 'black', category: 'hidden' }));
      }
      return p;
    });

    viewGame.players = list;
    viewGame.human = list.find((p) => String(p.seat) === String(meSeat)) || list[0];
    viewGame.aiPlayer = list.find((p) => p !== viewGame.human) || list[1] || list[0];
    viewGame.deck = viewGame.deck || {};
    viewGame.deck.remaining = snap.deckRemaining;
    viewGame.deck.discardPile = new Array(snap.discardCount || 0).fill(null);
    viewGame.deck.cards = [];
    viewGame.showcase = (snap.showcase || []).slice();
    viewGame.phase = snap.phase;
    viewGame.round = snap.round;
    viewGame.current = Math.max(0, list.findIndex((p) => String(p.seat) === String(snap.actorSeat)));
    viewGame.over = snap.over;
    viewGame.vsAI = snap.vsAI;
    viewGame.viewerSeat = meSeat;
    Object.defineProperty(viewGame, 'actor', {
      configurable: true,
      get() { return this.players[this.current] || this.players[0]; }
    });
    // 五谷面板在客机侧也要能渲染
    if (snap.wugu && viewGame.ui) {
      viewGame.ui.wuguSession = {
        cards: snap.wugu.cards.slice(),
        taken: Object.assign({}, snap.wugu.taken),
        turn: snap.wugu.turn
      };
    }
    return viewGame;
  };

  /** 造一个空视图 Game（不执行构造函数、不发牌、不跑主循环） */
  P.makeViewGame = function (ui) {
    const g = Object.create(SGS.Game.prototype);
    g.players = []; g.human = null; g.aiPlayer = null;
    g.deck = { remaining: 0, discardPile: [], cards: [] };
    g.showcase = [];
    g.phase = null; g.round = 1; g.current = 0; g.over = false;
    g.ui = ui;
    g.viewerSeat = 0;
    g.vsAI = false;
    Object.defineProperty(g, 'actor', {
      configurable: true, get() { return this.players[this.current] || this.players[0]; }
    });
    return g;
  };
})(typeof window !== 'undefined' ? window : globalThis);
