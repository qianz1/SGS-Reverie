/**
 * characters/zhugeliang.js
 * 【蜀】诸葛亮 —— 体力 3，称号「卧龙」，四技能 火计 / 看破 / 八阵 / 藏拙。
 *
 * 技能契约（角色文件内聚实现，主循环 / UI / AI 只认统一钩子）：
 *   火计（含「可以」，主动转化走右下技能按钮）
 *     · 一张红色「牌」当【火攻】使用：conversion red→huogong。
 *       「牌」= 手牌 + 装备区（不含判定区），素材可来自任意装备槽，
 *       由 Game.discardConsumed() / SGS.Zones.conversionCards() 统一处理。
 *     · ★ 改写本角色的【火攻】结算（huogongRule）：
 *         你观看目标手牌并展示其中一张 → 你弃置与其展示牌【颜色相同】的【手牌】
 *         → 对目标造成 1 点火焰伤害。
 *       因为要「看目标的手牌并挑一张展示」，新增 ui.waitPeekHand() 面板。
 *       旧版「观看牌堆顶 4 张 + 控顶排序 + 同花色代替」设计已取消，
 *       相关的牌堆顶查看面板与伤害计数钩子也一并移除。
 *   看破（含「可以」，无懈响应走右下技能按钮）
 *     · 一张黑色「牌」当【无懈可击】使用：conversion black→wuxiekeji，
 *       scenes:['wuxie']，素材同样可以是装备区的黑牌。
 *     · wuXieUnrespondable(player)=true：Game.askWuXie() 在这张无懈打出后
 *       直接结束「无懈打无懈」链 —— 只表示不可再被无懈可击响应。
 *   八阵（锁定技）
 *     · virtualArmor(player)：装备区没有防具时返回【八卦阵】的 equip spec。
 *   藏拙（锁定技）
 *     · handLimitExempt(player, card)：本回合未使用过锦囊牌时，锦囊牌
 *       （含延时锦囊）不计入手牌上限。
 *
 * ★ 更名后全项目口径统一：显示名 / 介绍名 / 立绘 / 角色 id / 脚本文件名
 *   都按「诸葛亮」取拼音 zhugeliang：
 *     脚本 js/characters/zhugeliang.js（index.html 引用同一路径）
 *     id / Characters key = zhugeliang
 *     立绘 assets/characters/SHU-ZhuGeLiang.webp（core.js 自动补势力前缀）
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Characters = SGS.Characters || (SGS.Characters = {});

  /** —— 角色数据 —— */
  const data = {
    id: 'zhugeliang',
    name: '诸葛亮',        // 规则层 / 日志用的完整名
    displayName: '诸葛亮', // 角色框里只写名字（不带势力前缀）
    introName: '诸葛亮',   // 角色介绍里写「蜀·诸葛亮」
    title: '卧龙',
    faction: '蜀',
    image: 'ZhuGeLiang.webp',       // → SHU-ZhuGeLiang.webp
    maxHp: 3,
    avatar: '诸',
    gender: 'male'
  };

  /** —— 技能实现 —— */
  const skill = {
    name: '火计',
    titles: '火计 · 看破 · 八阵 · 藏拙',
    desc: '火计：你可以将一张红色牌当【火攻】使用。你的【火攻】改为你观看目标的手牌然后展示其中一张牌，你弃置与其展示牌颜色相同的手牌以造成伤害。｜' +
          '看破：你可以将一张黑色牌当【无懈可击】使用。你的【无懈可击】不能被响应。｜' +
          '八阵（锁定技）：若你装备区里没有防具牌，你视为装备着【八卦阵】。｜' +
          '藏拙（锁定技）：弃牌阶段开始时，若你本回合未使用过锦囊牌，你的锦囊牌不计入手牌上限。',
    active: true,

    /**
     * ★【火计】改写的【火攻】规则，由 tricks.js 的 resolveHuogong() 读取：
     *   peek  = true   使用者查看目标全部手牌，并自己挑一张展示（新 UI）
     *   match = 'color' 弃置「颜色相同」的手牌（原版为「花色相同」）
     *   取消控顶：不再观看 / 排序牌堆顶，也不再有「代替弃置」分支。
     */
    huogongRule: { peek: true, match: 'color' },

    /** 不同场景的技能按钮文案：出牌是火计，无懈响应是看破 */
    buttonName(scene) {
      return scene === 'wuxie' ? '看破' : '火计';
    },

    /** 两条主动转化：红→火攻（出牌）、黑→无懈可击（无懈响应） */
    conversions: [
      {
        from: 'red', to: 'huogong', scenes: ['play'], skill: '火计',
        label: '红色牌当【火攻】'
      },
      {
        from: 'black', to: 'wuxiekeji', scenes: ['wuxie'], skill: '看破',
        label: '黑色牌当【无懈可击】'
      }
    ],

    /** 复核转化：只按颜色放行，其余牌型一律 false */
    asType(player, card, to) {
      if (!card) return false;
      const red = card.color === 'red' ||
        card.suit === '\u2665' || card.suit === '\u2666';
      const black = card.color === 'black' ||
        card.suit === '\u2660' || card.suit === '\u2663';
      if (to === 'huogong') return red;
      if (to === 'wuxiekeji') return black;
      return false;
    },

    /** 【八阵】：装备区没有防具时视为装备【八卦阵】 */
    virtualArmor(player) {
      if (player && player.equips && player.equips.armor) return null;
      return SGS.Cards && SGS.Cards.equipOf
        ? SGS.Cards.equipOf('baguazhen') : { slot: 'armor', bagua: true };
    },

    /** 【看破】：本角色的【无懈可击】不可再被无懈可击响应 */
    wuXieUnrespondable(player) {
      return true;
    },

    /** 【藏拙】：本回合没用过锦囊牌时，锦囊（含延时锦囊）不计入手牌上限 */
    handLimitExempt(player, card) {
      if (!card || player.trickUsedThisTurn) return false;
      return !!(SGS.Cards && SGS.Cards.isTrick(card.type));
    },

    // 四技能都不改变出杀次数
    shaLimit(player, defaultLimit) {
      return defaultLimit;
    }
  };

  Characters.zhugeliang = Object.assign({}, data, { skill: skill });
})(typeof window !== 'undefined' ? window : globalThis);
