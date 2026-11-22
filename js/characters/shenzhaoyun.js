/**
 * characters/shenzhaoyun.js
 * 【神】赵云 —— 体力 2，双技能「绝境」+「龙魂」。
 *
 * 技能契约（角色文件内聚实现，主循环 / UI / AI 只认统一钩子）：
 *   绝境（锁定技）
 *     · handLimitBonus(player, base)  → 手牌上限 +2（Player.handLimit 调用）
 *     · onBrinkState(game, player, state) → 进入 / 脱离濒死各摸一张牌
 *       （Game.brink() 在 state='enter' / 'leave' 时 await 调用）
 *   龙魂（「可以」类主动技，必须点技能按钮发动）
 *     ★ 描述写「牌」= 手牌 + 装备区（不含判定区），素材可在技能选牌
 *       模式下直接点装备栏选取；由 SGS.Zones.conversionCards() 统一枚举。
 *     · conversions 描述四条按花色的转化方向，from 直接写花色字符，
 *       scenes 标注可用场景：play（出牌）/ respond（响应）/ brink（濒死）/
 *       wuxie（无懈响应）。to 用于按「当前需要的牌」过滤，asType 是
 *       转化后真正当作的牌型（♦ 当的是【火杀】，带火焰伤害）。
 *     · asType(player, card, to) 供 Player.canUseAsType() 复核花色合法性；
 *       装备区的牌同样按花色参与转化，离场由 Game.discardConsumed() 处理。
 *       不改写 asSha / asShan，避免 AI / 普通选牌把转化牌当成天然可用牌。
 *
 * 花色与牌面数据的约定见 cards.js：♥ ♦ 为红色，♠ ♣ 为黑色；
 * SGS.Cards.matchesFrom(card, '♥') 负责花色匹配（含颜色兜底）。
 * 素材 assets/characters/SHEN-ZhaoYun.webp（已带势力前缀，core.js 原样返回）。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Characters = SGS.Characters || (SGS.Characters = {});

  /** 龙魂花色表：♥→桃 / ♦→火杀 / ♣→闪 / ♠→无懈可击 */
  const DRAGON_SOUL = {
    '\u2665': 'tao',        // ♥
    '\u2666': 'huosha',     // ♦
    '\u2663': 'shan',       // ♣
    '\u2660': 'wuxiekeji'   // ♠
  };

  /** —— 角色数据 —— */
  const data = {
    id: 'shenzhaoyun',
    name: '神赵云',       // 日志 / 选将区分用的完整名
    displayName: '赵云',  // ★ 角色框里只写名字，不叠势力（势力由左上角标识表示）
    title: '神威如龙',
    faction: '神',
    image: 'SHEN-ZhaoYun.webp',
    maxHp: 2,
    avatar: '神',
    gender: 'male'
  };

  /** —— 技能实现 —— */
  const skill = {
    // 技能按钮（右下）与日志里的短名；选将界面用 titles 展示双技能
    name: '龙魂',
    titles: '绝境 · 龙魂',
    desc: '绝境（锁定技）：你的手牌上限 +2；当你进入或脱离濒死状态时，你摸一张牌。｜' +
          '龙魂：你的牌（含装备区）可以按以下规则使用或打出：♥当【桃】；♦当火【杀】；♣当【闪】；♠当【无懈可击】。',
    // desc 含「可以」，且显式标记主动技 → ui.js 给独立技能按钮
    active: true,

    /* ── 绝境：锁定技 ────────────────────────────────────────── */

    /** 手牌上限 = 当前体力 + 2（满血 2 体力时上限 4，掉到 1 血时上限 3） */
    handLimitBonus(player, base) {
      return base + 2;
    },

    /**
     * 进入 / 脱离濒死状态各摸一张牌。锁定技：不询问、不进技能按钮。
     * 摸牌走 Game.drawCards()（与摸牌阶段 / 无中生有同款动画），摸到的
     * 【桃】/【酒】/♥ 牌可以立刻继续用于本次濒死自救 —— Game.brink()
     * 每轮都会重算可用的自救牌。
     */
    async onBrinkState(game, player, state) {
      const word = state === 'enter' ? '进入' : '脱离';
      if (SGS.log) {
        SGS.log(player.name + ' 发动【绝境】，' + word + '濒死状态，摸一张牌。', 'sys');
      }
      await game.drawCards(player, 1);
      if (SGS.log) {
        SGS.log(player.name + '【绝境】摸牌后手牌 ' + player.hand.length + ' 张。', 'sys');
      }
    },

    /* ── 龙魂：主动转化 ──────────────────────────────────────── */

    conversions: [
      {
        from: '\u2665', to: 'tao', scenes: ['play', 'brink'], skill: '龙魂',
        label: '♥ 当【桃】'
      },
      {
        // to='sha' 让响应 need='sha'（南蛮 / 决斗）能自动选中这一项；
        // asType 告诉 Game.useSha() 真正当作【火杀】，伤害带火焰属性。
        from: '\u2666', to: 'sha', asType: 'huosha', scenes: ['play', 'respond'], skill: '龙魂',
        label: '♦ 当火【杀】'
      },
      {
        from: '\u2663', to: 'shan', scenes: ['respond'], skill: '龙魂',
        label: '♣ 当【闪】'
      },
      {
        from: '\u2660', to: 'wuxiekeji', scenes: ['wuxie'], skill: '龙魂',
        label: '♠ 当【无懈可击】'
      }
    ],

    /**
     * 复核「这张牌能否当作 to 使用 / 打出」。
     * 只按花色判断，不改 canUseAsSha / canUseAsShan，因此普通出牌、AI 的
     * 自动选牌都不会把龙魂转化牌当成天然可用牌 —— 必须点技能按钮发动。
     * ♦ 的目标牌型是【火杀】，同时也接受 to='sha'（响应过滤用的类型）。
     */
    asType(player, card, to) {
      if (!card) return false;
      const t = DRAGON_SOUL[card.suit];
      if (!t) return false;
      if (to === 'sha') return t === 'huosha';
      return t === to;
    },

    // 绝境不改变出杀次数；龙魂也不放宽【杀】次数（♦ 当火杀照常消耗 1 次）
    shaLimit(player, defaultLimit) {
      return defaultLimit;
    }
  };

  Characters.shenzhaoyun = Object.assign({}, data, { skill: skill });
})(typeof window !== 'undefined' ? window : globalThis);
