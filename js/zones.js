/**
 * zones.js
 * 角色「所有区域内的牌」统一入口：手牌区、装备区、判定区。
 *
 * ── 为什么要单独一层 ────────────────────────────────────────
 * 【过河拆桥】/【顺手牵羊】的「有牌角色」按原版是指该角色**任意区域**有牌，
 * 而不只是手牌；被拆 / 被牵的牌也可以来自装备区或判定区。手牌是暗信息
 * （面板显示牌背），装备区与判定区的牌所有角色都能看到：面板直接铺原
 * 卡牌贴图（贴图自带名称与描述），只补花色 + 点数，不用牌背；判定区贴图
 * 再顺时针旋转 90° 横置。主战斗界面的装备栏仍是纯文字 UI，不受影响。
 *
 * 这里把「枚举 / 按 id 查找 / 按 id 取走」收敛成一套，game.js 的目标筛选、
 * tricks.js 的结算、ui.js 的目标牌区面板都只读这一层，将来新增区域
 * （如真正的延时锦囊牌落进判定区）时三处自动一起生效。
 *
 * 区域定义：
 *   hand     手牌区，暗牌，player.hand 数组
 *   equip    装备区四槽（weapon / armor / horsePlus / horseMinus），明牌
 *   delayed  判定区，明牌，player.delayed 数组
 *            （延时锦囊牌使用后置入，判定阶段由 game.phaseJudge() 结算）
 *
 * ★ 另有 conversionCards()：技能描述里「牌」的统一语义 = 手牌 + 装备区
 *   （不含判定区）。见函数处注释。
 *
 * 不依赖 DOM，可在 Node 自测里直接使用。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  /** 装备槽显示名（用于日志与面板） */
  const SLOT_LABEL = {
    weapon: '武器', armor: '防具', horsePlus: '+1马', horseMinus: '-1马'
  };

  /** 判定区最多三个占位格（与面板 UI 一致） */
  const DELAYED_SLOTS = 3;

  function entriesOfHand(player) {
    return (player && player.hand || []).map((card) => ({
      id: card.id,
      card: card,
      zone: 'hand',
      zoneKey: 'hand',
      label: '手牌',
      faceUp: false,      // 暗牌 → 面板显示牌背
      note: ''
    }));
  }

  function entriesOfEquips(player) {
    if (!player || !player.equips || !SGS.Equipment) return [];
    return SGS.EQUIP_SLOTS.map((s) => {
      const card = player.equips[s.key];
      if (!card) return null;
      return {
        id: card.id,
        card: card,
        zone: 'equip',
        zoneKey: s.key,
        label: '装备区·' + (SLOT_LABEL[s.key] || s.label),
        faceUp: true,     // 明牌 → 面板正面显示，不用牌背
        note: SGS.Equipment.noteOf(card, true) || ''
      };
    }).filter(Boolean);
  }

  function entriesOfDelayed(player) {
    return (player && player.delayed || []).map((card) => ({
      id: card.id,
      card: card,
      zone: 'delayed',
      zoneKey: 'delayed',
      label: '判定区',
      faceUp: true,       // 明牌 → 面板正面显示，不用牌背
      note: ''
    }));
  }

  /** 全部区域的牌（顺序：手牌 → 装备区四槽 → 判定区） */
  function list(player) {
    return entriesOfHand(player)
      .concat(entriesOfEquips(player))
      .concat(entriesOfDelayed(player));
  }

  function count(player) { return list(player).length; }
  function hasAny(player) { return count(player) > 0; }
  function find(player, id) { return list(player).find((e) => e.id === id) || null; }

  /**
   * 「有牌」但**不含判定区**的牌：手牌 + 装备区四槽。
   * 【寒冰剑】弃牌专用 —— 规则要求区分「有牌」与「有手牌」，
   * 且判定区的牌不能被弃置。返回条目数组（顺序同 list）。
   *
   * ★ 只有【寒冰剑】用这一层做排除。【过河拆桥】/【顺手牵羊】走的是
   *   list() / take()，判定区的牌照样能被拆掉或牵走。
   */
  function disposable(player) {
    return list(player).filter((e) => e.zone !== 'delayed');
  }

  /**
   * ★「牌」的统一语义：手牌区 + 装备区四槽，**不含判定区**。
   * 技能描述里写「你可以将一张牌当…使用或打出」（【龙魂】/【渐营】/
   * 【火计】/【看破】等）时，素材就从这里枚举 —— 装备区已装上的牌也能
   * 被转化使用或打出。明确写「手牌」的技能（丈八蛇矛、贯石斧、火攻弃牌
   * 等）仍只从 player.hand 取，不受影响。
   * 与 disposable() 当前集合相同，但语义独立：前者用于「可弃置」，
   * 这里用于「可作为技能素材」，将来规则分化时各自演进。
   */
  function conversionCards(player) {
    return disposable(player);
  }
  function hasConversionCard(player) { return conversionCards(player).length > 0; }
  function findConversionCard(player, id) {
    const e = conversionCards(player).find((x) => String(x.id) === String(id));
    return e || null;
  }

  /** 是否含有可被弃置的牌（不含判定区） */
  function hasDisposable(player) { return disposable(player).length > 0; }

  /**
   * 从对应区域真正取走一张牌，找不到时返回 null（不改动任何状态）。
   * 注意：本层只做「移除」这一纯状态变更，不改体力。若取走的是装备区的
   * 【白银狮子】，调用方（tricks.js 的过河拆桥 / 顺手牵羊）还须调用
   * Game.onEquipmentLost(player, card) 结算失去装备的回血效果；
   * 「同槽替换」路径则在 Game.useEquip() 里通知。所有失去入口保持统一。
   */
  function take(player, id) {
    const entry = find(player, id);
    if (!entry) return null;
    let card = null;
    if (entry.zone === 'hand') {
      card = player.removeCard ? player.removeCard(id) : null;
    } else if (entry.zone === 'equip') {
      card = SGS.Equipment.unmount(player, id);
    } else if (entry.zone === 'delayed') {
      const i = player.delayed.findIndex((c) => c.id === id);
      if (i >= 0) card = player.delayed.splice(i, 1)[0];
    }
    return card ? entry : null;
  }

  /** UI / 测试桩缺席时的兜底：优先随机手牌，否则随机任意区域的明牌 */
  function takeRandom(player) {
    const all = list(player);
    if (!all.length) return null;
    const hand = all.filter((e) => e.zone === 'hand');
    const pool = hand.length ? hand : all;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return take(player, pick.id);
  }

  /** 把一张牌放进判定区（供将来接延时锦囊牌使用） */
  function addDelayed(player, card) {
    if (!player.delayed) player.delayed = [];
    player.delayed.push(card);
    return card;
  }

  /** 日志里的一句话区域说明 */
  function zoneText(entry) {
    if (!entry) return '一张牌';
    return entry.zone === 'hand' ? '手牌' : entry.label;
  }

  SGS.Zones = {
    SLOT_LABEL: SLOT_LABEL,
    DELAYED_SLOTS: DELAYED_SLOTS,
    list: list,
    count: count,
    hasAny: hasAny,
    disposable: disposable,
    hasDisposable: hasDisposable,
    conversionCards: conversionCards,
    hasConversionCard: hasConversionCard,
    findConversionCard: findConversionCard,
    find: find,
    take: take,
    takeRandom: takeRandom,
    addDelayed: addDelayed,
    zoneText: zoneText
  };
})(typeof window !== 'undefined' ? window : globalThis);
