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
    const seen = [];

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
      if (seen.indexOf(v) >= 0) return null;   // 防御环形引用
      seen.push(v);
      if (isGame(v)) return { __t: 'game' };
      if (isPlayer(v)) return { __t: 'p', seat: v.seat };
      if (isCard(v)) return { __t: 'c', card: plainCard(v) };
      if (Array.isArray(v)) return v.map(walk);
      const out = {};
      Object.keys(v).forEach((k) => {
        if (k === 'resolve' || k === 'game') return;  // 不传内部字段
        out[k] = walk(v[k]);
      });
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
      // 回合内状态：客机的按钮置灰 / 技能栏要靠这些字段
      shaUsed: p.shaUsed || 0, jiuUsed: !!p.jiuUsed,
      jianyingUsed: !!p.jianyingUsed,
      trickUsedThisTurn: !!p.trickUsedThisTurn,
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
      p.shaUsed = d.shaUsed || 0; p.jiuUsed = !!d.jiuUsed;
      p.jianyingUsed = !!d.jianyingUsed;
      p.trickUsedThisTurn = !!d.trickUsedThisTurn;
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
