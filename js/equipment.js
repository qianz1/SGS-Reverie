/**
 * equipment.js
 * 装备区与装备效果的「纯逻辑层」：槽位、挂载 / 替换、效果查询。
 *
 * 牌面数据（名称 / 花色 / 图片 / 各装备的数值）在 cards.js 的 CARD_DEFS[].equip；
 * 角色实体上的 equips 状态在 player.js；界面渲染在 ui.js；规则接入在 game.js。
 * 本文件不碰 DOM，因此可直接在 Node 自测里使用。
 *
 * ── 四个装备槽（固定顺序，界面按此顺序画横栏） ──────────────
 *   weapon     武器   → 提供「攻击范围」（默认无武器时为 1）
 *   armor      防具   → 可让黑色的【杀】无效
 *   horsePlus  +1 马  → 其他角色计算与你的距离时 +1
 *   horseMinus -1 马  → 你计算与其他角色的距离时 -1
 *
 * ── 装备牌 ────────────────────────────────────────────────
 *   诸葛连弩（武器，攻击范围 1）  锁定技：使用【杀】无次数限制
 *   +1 马：绝影 / 的卢 / 爪黄飞电  其他角色计算与你的距离时始终 +1
 *   -1 马：赤兔 / 紫骍 / 大宛      你计算与其他角色的距离时始终 -1
 *   仁王盾（防具）               锁定技：黑色的【杀】对你无效
 *   藤甲（防具）                 锁定技：【南蛮入侵】【万箭齐发】和普通【杀】
 *                               对你无效；受到火焰伤害时该伤害 +1
 *   白银狮子（防具）             锁定技：大于 1 点的伤害减至 1 点；
 *                               **失去**它（含替换 / 被拆 / 被牵）回复 1 点体力
 *   八卦阵（防具）               「可以」类：需要【闪】时判定，红色视为有【闪】
 *   朱雀羽扇（武器，范围 4）      「可以」类：普通【杀】可改为火【杀】
 *   青釭剑（武器，范围 2）        锁定技：【杀】指定目标后无视其防具
 *   丈八蛇矛（武器，范围 3）      主动转化：点武器栏选两张手牌当【杀】
 *   寒冰剑（武器，范围 2）        「可以」类：防止伤害，改弃目标两张牌
 *   麒麟弓（武器，范围 5）        「可以」类：杀造成伤害时弃目标一张坐骑
 *   雌雄双股剑（武器，范围 2）    「可以」类：杀指定异性后目标二选一
 *   贯石斧（武器，范围 3）        「可以」类：杀被闪抵消后弃两张牌仍造成伤害
 *   方天画戟（武器，范围 4）      锁定技：最后一张手牌的【杀】可多两个目标
 *   青龙偃月刀（武器，范围 3）    「可以」类：杀被闪抵消后再对目标用一张杀
 *   古锭刀（武器，范围 2）        锁定技：目标无手牌时杀伤害 +1
 *
 * 锁定技装上即持续生效，不需要主动发动、不进技能按钮。
 * 距离修正通过 Game.distance() 叠加，杀次数通过 Player.shaLimit() 叠加，
 * 杀无效在 Game.useSha() 询问【闪】之前判定，群体锦囊无效在
 * Tricks.resolveAOE() 里跳过该目标，火焰加伤 / 白银狮子减伤在 Game.damage()
 * 里结算。「可以」类装备由 Game.askOptional() 询问；失去装备的触发由
 * Game.onEquipmentLost() 统一结算（所有失去入口都必须调它）。
 *
 * ★ 青釭剑的「无视防具」是一条贯穿整次【杀】结算的标记：Game.useSha()
 *   算出 armorNegated 后，同时传给 blockingArmor / askRespond（八卦阵）/
 *   damage（藤甲火焰加伤、白银狮子减伤），保证这次杀里防具全部失效。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  /** 装备槽（顺序即界面从上到下的顺序） */
  const SLOTS = [
    { key: 'weapon',     label: '武器',  empty: '— 武器 —',  panel: '武器牌' },
    { key: 'armor',      label: '防具',  empty: '— 防具 —',  panel: '防具牌' },
    { key: 'horsePlus',  label: '+1马',  empty: '— +1马 —',  panel: '+1马' },
    { key: 'horseMinus', label: '-1马',  empty: '— -1马 —',  panel: '-1马' }
  ];

  function emptyEquips() {
    const o = {};
    SLOTS.forEach((s) => { o[s.key] = null; });
    return o;
  }

  /** 这张牌的装备效果数据（没有则是 null） */
  function specOf(card) {
    return card ? SGS.Cards.equipOf(card.type) : null;
  }

  /**
   * 这张牌属于哪个装备槽。
   * 同时接受「牌对象」与「牌类型字符串」两种入参：调用方有时手上只有
   * card.type（如筛选手牌时），传进来也必须能查到槽位，否则会误判为空槽。
   */
  function slotOf(card) {
    const e = typeof card === 'string' ? SGS.Cards.equipOf(card) : specOf(card);
    return e ? e.slot : null;
  }

  /** 取某角色某槽上的牌（普通对象 / 无 equips 的测试桩也安全） */
  function cardIn(player, slotKey) {
    return (player && player.equips && player.equips[slotKey]) || null;
  }

  /**
   * ★ 当前生效的防具 spec：优先读装备区里的真实防具；若没有防具且角色
   *   技能提供了 virtualArmor（【八阵】视为装备【八卦阵】），则读虚拟 spec。
   *   所有防具查询（挡杀 / 挡 AOE / 火焰加伤 / 减伤 / 八卦阵标记）统一走这里，
   *   因此【青釭剑】的 armorNegated 开关把虚拟防具也一并屏蔽。
   */
  function armorSpec(player) {
    const real = cardIn(player, 'armor');
    if (real) return specOf(real);
    const v = (player && typeof player.hook === 'function')
      ? player.hook('virtualArmor') : null;
    if (!v && player && player.skill && typeof player.skill.virtualArmor === 'function') {
      return player.skill.virtualArmor(player);
    }
    return v || null;
  }

  /** 供日志使用：真实防具牌，或虚拟防具的占位对象（带 name） */
  function armorCard(player) {
    return cardIn(player, 'armor') ||
      (armorSpec(player) ? { name: '八卦阵', type: 'baguazhen', virtual: true } : null);
  }

  /** 已装备的牌数组（按槽顺序） */
  function allCards(player) {
    return SLOTS.map((s) => cardIn(player, s.key)).filter(Boolean);
  }

  function count(player) {
    return allCards(player).length;
  }

  /** 装上牌，返回被替换下来的旧牌（没有则 null）；不改手牌，由调用方 removeCard */
  function mount(player, card) {
    const slot = slotOf(card);
    if (!slot) return null;
    if (!player.equips) player.equips = emptyEquips();
    const old = player.equips[slot] || null;
    player.equips[slot] = card;
    return old;
  }

  /** 按牌 id 卸下一件装备并返回它（锦囊拆装备 / 将来扩展用） */
  function unmount(player, cardId) {
    if (!player || !player.equips) return null;
    for (const s of SLOTS) {
      const c = player.equips[s.key];
      if (c && c.id === cardId) {
        player.equips[s.key] = null;
        return c;
      }
    }
    return null;
  }

  /** 【杀】的攻击范围：武器上的 range，无武器默认 1 */
  function attackRange(player) {
    const w = cardIn(player, 'weapon');
    const spec = specOf(w);
    return spec && spec.range ? spec.range : 1;
  }

  /** +1 马：别人算「到我」的距离时 +1 */
  function distanceBonus(player) {
    const h = cardIn(player, 'horsePlus');
    const spec = specOf(h);
    return spec ? (spec.distanceBonus || 0) : 0;
  }

  /** -1 马：我算「到别人」的距离时 -1 */
  function distanceReduce(player) {
    const h = cardIn(player, 'horseMinus');
    const spec = specOf(h);
    return spec ? (spec.distanceReduce || 0) : 0;
  }

  /** 武器是否解除【杀】次数限制 */
  function unlimitedSha(player) {
    const w = cardIn(player, 'weapon');
    const spec = specOf(w);
    return !!(spec && spec.unlimitedSha);
  }

  /**
   * 防具是否让这张【杀】无效，返回挡下的那件防具牌（没挡下返回 null）。
   *  · 【仁王盾】黑色的【杀】无效：颜色取「实际打出的那张牌」的 color，
   *    龙胆把黑色【闪】当【杀】时同样算黑杀。
   *  · 【藤甲】「普通【杀】」无效：即伤害属性为 normal 的杀（普通杀、
   *    龙胆转化出的杀）；【火杀】【雷杀】是属性杀，藤甲挡不住。
   */
  function blockingArmor(player, shaCard) {
    const spec = armorSpec(player);
    if (!spec || !shaCard) return null;
    if (spec.blocksBlackSha && shaCard.color === 'black') return armorCard(player);
    if (spec.blocksNormalSha && SGS.Cards.damageTypeOf(shaCard) === 'normal') return armorCard(player);
    return null;
  }

  function blocksSha(player, shaCard) {
    return !!blockingArmor(player, shaCard);
  }

  /** 【藤甲】：【南蛮入侵】/【万箭齐发】对该角色无效（不响应、不受伤） */
  function blocksAOE(player, reason) {
    const spec = armorSpec(player);
    return !!(spec && spec.blocksAOE &&
      (reason === '南蛮入侵' || reason === '万箭齐发'));
  }

  /** 【藤甲】：受到火焰伤害时该伤害 +1，返回加值（0 或 1） */
  function fireDamageBonus(player) {
    const spec = armorSpec(player);
    return spec && spec.fireVulnerable ? 1 : 0;
  }

  /** 【白银狮子】：大于 1 点的伤害减至 1 点，返回上限（Infinity = 无上限） */
  function damageCap(player) {
    const spec = armorSpec(player);
    return spec && spec.damageCap ? spec.damageCap : Infinity;
  }

  /**
   * 失去一件装备时触发的效果（按「被失去的那张牌」查，此时它可能已从
   * 装备区移除）。目前只有【白银狮子】：回复 loseHeal 点体力。
   */
  function loseHealOf(card) {
    const spec = specOf(card);
    return spec && spec.loseHeal ? spec.loseHeal : 0;
  }

  /** 防具是否带某个「可以」类标记（如 bagua） */
  function armorFlag(player, key) {
    const spec = armorSpec(player);
    return !!(spec && spec[key]);
  }

  /** 武器是否带某个标记（zhuque / ignoreArmor / zhangba / hanbing） */
  function weaponFlag(player, key) {
    const spec = specOf(cardIn(player, 'weapon'));
    return !!(spec && spec[key]);
  }

  /** 【青釭剑】：锁定技，这次【杀】无视目标防具 */
  function ignoresArmor(player) {
    return weaponFlag(player, 'ignoreArmor');
  }

  /** 【丈八蛇矛】：可点武器栏把两张手牌当【杀】使用或打出 */
  function hasZhangba(player) {
    return weaponFlag(player, 'zhangba');
  }

  /** 【寒冰剑】：可防止杀伤害，改弃目标两张牌 */
  function hasHanbing(player) {
    return weaponFlag(player, 'hanbing');
  }

  /** 【麒麟弓】：杀造成伤害时可弃目标坐骑 */
  function hasQilin(player) {
    return weaponFlag(player, 'qilin');
  }

  /** 【雌雄双股剑】：杀指定异性后目标二选一 */
  function hasCixiong(player) {
    return weaponFlag(player, 'cixiong');
  }

  /** 【贯石斧】：杀被闪抵消后弃两张牌仍造成伤害 */
  function hasGuanshi(player) {
    return weaponFlag(player, 'guanshi');
  }

  /** 【方天画戟】：最后一张手牌的【杀】可多两个目标 */
  function hasFangtian(player) {
    return weaponFlag(player, 'fangtian');
  }

  /** 【青龙偃月刀】：杀被闪抵消后可再对目标用一张杀 */
  function hasQinglong(player) {
    return weaponFlag(player, 'qinglong');
  }

  /** 【古锭刀】：目标无手牌时杀伤害 +1 */
  function hasGudingdao(player) {
    return weaponFlag(player, 'guding');
  }

  /**
   * ★ 这个人是不是「靠多刀吃饭」的角色：手里有【诸葛连弩】就值得换装。
   *   张春华（伤逝补牌）与沮授（渐营摸牌）都能攒出一手【杀】，
   *   连弩对他们是质变，别的武器再多一点也不换。
   *   只认这两名角色，别的 AI 仍按「只填空槽」的老规则，不乱顶装备。
   */
  const CROSSBOW_SEEKERS = { zhangchunhua: true, jushou: true };
  function wantsCrossbow(player) {
    const id = player && player.char && player.char.id;
    return !!(id && CROSSBOW_SEEKERS[id]);
  }

  /** 装备区里的坐骑牌（+1 马 / -1 马），供【麒麟弓】筛选 */
  function horsesOf(player) {
    return ['horsePlus', 'horseMinus']
      .map((s) => cardIn(player, s))
      .filter(Boolean);
  }

  /** 装备栏里显示的一行说明（武器写攻击范围、马写加减距离，防具留空） */
  function noteOf(card, mini) {
    const spec = specOf(card);
    if (!spec) return '';
    return mini ? (spec.short || '') : (spec.note || '');
  }

  /** 目标牌区面板里对应槽的文案 */
  function panelLabel(slotKey) {
    const s = SLOTS.find((x) => x.key === slotKey);
    return s ? s.panel : slotKey;
  }

  SGS.EQUIP_SLOTS = SLOTS;
  SGS.Equipment = {
    slots: SLOTS,
    emptyEquips: emptyEquips,
    specOf: specOf,
    slotOf: slotOf,
    cardIn: cardIn,
    armorSpec: armorSpec,
    armorCard: armorCard,
    allCards: allCards,
    count: count,
    mount: mount,
    unmount: unmount,
    attackRange: attackRange,
    distanceBonus: distanceBonus,
    distanceReduce: distanceReduce,
    unlimitedSha: unlimitedSha,
    blocksSha: blocksSha,
    blockingArmor: blockingArmor,
    blocksAOE: blocksAOE,
    fireDamageBonus: fireDamageBonus,
    damageCap: damageCap,
    loseHealOf: loseHealOf,
    armorFlag: armorFlag,
    weaponFlag: weaponFlag,
    ignoresArmor: ignoresArmor,
    hasZhangba: hasZhangba,
    hasHanbing: hasHanbing,
    hasQilin: hasQilin,
    hasCixiong: hasCixiong,
    hasGuanshi: hasGuanshi,
    hasFangtian: hasFangtian,
    wantsCrossbow: wantsCrossbow,
    hasQinglong: hasQinglong,
    hasGudingdao: hasGudingdao,
    horsesOf: horsesOf,
    noteOf: noteOf,
    panelLabel: panelLabel
  };
})(typeof window !== 'undefined' ? window : globalThis);
