/**
 * player.js
 * 玩家 / AI 共用实体：体力、手牌、回合状态，并把技能钩子分发到角色文件。
 * 默认规则集中在这里，角色文件只覆盖自己想改的部分。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  /** 不带技能时的默认规则 */
  const DEFAULT_HOOKS = {
    shaLimit(player, defaultLimit) {
      return defaultLimit; // 每回合限 1 张杀
    },
    asSha(player, card) {
      return SGS.Cards.isSha(card.type);   // 普通杀 / 火杀 / 雷杀
    },
    asShan(player, card) {
      return card.type === 'shan';
    },
    /** 手牌上限的加成（【绝境】等锁定技覆盖；默认 0 = 上限等于当前体力） */
    handLimitBonus(player, base) {
      return base;
    },
    /** 这张手牌是否「不计入手牌上限」（【藏拙】：未用锦囊时锦囊牌不计入） */
    handLimitExempt(player, card) {
      return false;
    },
    /** 虚拟防具：装备区没有防具时视为装备的防具 spec（【八阵】→ 八卦阵） */
    virtualArmor(player) {
      return null;
    },
    /** 该角色使用的【无懈可击】是否不可被响应（【看破】） */
    wuXieUnrespondable(player) {
      return false;
    },
    /** 出牌阶段每使用一张牌后触发（【渐营】：与上一张同花色/点数则直接摸牌） */
    onPlayCard(game, player, current, previous) {
      return undefined;
    },
    /** 每次受到伤害后触发，count = 本回合第几次（【矢北】第一/第二次） */
    onDamaged(game, player, count, info) {
      return undefined;
    },
    /** 【火攻】对目标造成伤害后触发（【火计】观看牌数递减） */
    onHuogongDamage(game, player) {
      return undefined;
    }
  };

  class Player {
    /**
     * @param {object} character 角色对象（来自 characters/*.js）
     * @param {boolean} isHuman  true = 真人玩家
     */
    constructor(character, isHuman) {
      this.char = character;
      this.isHuman = !!isHuman;
      this.name = character.name;
      this.maxHp = character.maxHp;
      this.hp = character.maxHp;
      this.gender = character.gender || 'male';  // 【雌雄双股剑】异性判定
      this.hand = [];
      this.shaUsed = 0;      // 本回合已使用的【杀】次数
      this.jiuUsed = false;  // 本回合是否已用【酒】（出牌阶段每回合限一次）
      this.jiuBuff = false;  // 本回合下一张【杀】伤害 +1（用酒后置位，出杀后消耗）
      // 延时锦囊造成的阶段跳过标记（只在当前回合有效，由 Game.phasePrepare 重置）
      this.skipDraw = false;
      this.skipPlay = false;
      // 装备区：四个槽各放一张装备牌（null = 空）。装备效果由 equipment.js 查询。
      this.equips = { weapon: null, armor: null, horsePlus: null, horseMinus: null };
      // 判定区：明牌数组，存放【乐不思蜀】【兵粮寸断】【闪电】等延时锦囊牌。
      // 【过河拆桥】/【顺手牵羊】的「任意区域有牌」判定与目标牌区面板也把它算进去。
      this.delayed = [];
      // 连环状态（【铁索连环】横置）：跨回合保持，只有被铁索重置或受到
      // 属性伤害传导后才会清除；角色框中间的横向锁链由 ui.render 读取它绘制。
      this.chained = false;
      // ── 角色技能用到的「每回合 / 每阶段」状态（统一在 resetTurn 重置）──
      this.playLog = [];            // 本阶段「使用」过的牌（含花色/点数/当作牌型）
      this.trickUsedThisTurn = false; // 本回合是否使用过锦囊牌（【藏拙】）
      this.jianyingUsed = false;     // 【渐营】出牌阶段限一次转化
      this.turnDamageCount = 0;      // 【矢北】本回合受到伤害的次数（所有角色每回合重置）
      this.shibeiHealed = false;     // 【矢北】本回合第一次伤害是否已回血
    }

    get skill() {
      return this.char.skill || {};
    }

    /** 调用技能钩子；角色未实现时回落到默认规则 */
    hook(name, ...args) {
      const fn = this.skill[name] || DEFAULT_HOOKS[name];
      return fn ? fn(this, ...args) : undefined;
    }

    /**
     * 本回合【杀】的使用上限。
     * 先取角色技能（张飞【咆哮】= Infinity），再叠加装备的锁定技：
     * 【诸葛连弩】装上后同样无次数限制。
     */
    shaLimit() {
      const fromSkill = this.hook('shaLimit', 1);
      if (SGS.Equipment && SGS.Equipment.unlimitedSha(this)) return Infinity;
      return fromSkill;
    }

    /**
     * 装备一张牌到对应槽，返回被替换下来的旧牌（没有则 null）。
     * 只改装备区状态；移出手牌与弃置旧牌由 Game.useEquip() 负责。
     */
    equip(card) {
      return SGS.Equipment.mount(this, card);
    }

    /** 这张手牌能否当作【杀】使用 */
    canUseAsSha(card) {
      return !!this.hook('asSha', card);
    }

    /** 这张手牌能否当作【闪】打出 */
    canUseAsShan(card) {
      return !!this.hook('asShan', card);
    }

    /**
     * 技能转化的通用复核：这张手牌能否当作 to 类型的牌「使用 / 打出」。
     *  · 'sha' / 'shan' 先看原有的 asSha / asShan 钩子（龙胆等），再叠加
     *    角色文件里的 asType(player, card, to)（【龙魂】按花色转化）。
     *  · 'tao' / 'wuxiekeji' 等只认 asType。
     * ★ 只读判断，不会改写 canUseAsSha / canUseAsShan，因此普通出牌与 AI
     *   自动选牌不会把转化牌当成天然可用牌 —— 主动技仍必须点技能按钮。
     */
    canUseAsType(card, to) {
      const viaSkill = (this.skill && typeof this.skill.asType === 'function')
        ? !!this.skill.asType(this, card, to) : false;
      if (to === 'sha' || to === 'huosha') return this.canUseAsSha(card) || viaSkill;
      if (to === 'shan') return this.canUseAsShan(card) || viaSkill;
      return viaSkill;
    }

    /** 是否还能使用【杀】 */
    canPlaySha() {
      return this.shaUsed < this.shaLimit();
    }

    /** 切换连环状态（横置 ↔ 重置），返回切换后的状态 */
    toggleChain() {
      this.chained = !this.chained;
      return this.chained;
    }

    draw(deck, n) {
      const cards = deck.draw(n);
      this.hand.push(...cards);
      return cards;
    }

    /** 按 id 移出一张手牌并返回它 */
    /**
     * 取走一张「牌」：优先手牌区，找不到再到装备区四槽。
     * ★ 技能描述写「牌」时（【龙魂】/【渐营】/【火计】/【看破】…），素材
     *   可以是已经装上的装备牌；这里统一承载离场动作，调用方不必关心来源。
     *   判定区的牌不属于「牌」，不从这里取。
     *   若确实取走的是装备牌，用 lastRemovedZone() 读取来源，由 Game 结算
     *   「失去装备区里的牌」（【白银狮子】回血等）—— Player 不依赖 Game。
     */
    removeCard(cardId) {
      const i = this.hand.findIndex((c) => c.id === cardId);
      if (i >= 0) {
        this._lastRemoved = { zone: 'hand', zoneKey: 'hand' };
        return this.hand.splice(i, 1)[0];
      }
      if (SGS.Equipment && typeof SGS.Equipment.unmount === 'function') {
        const c = SGS.Equipment.unmount(this, cardId);
        if (c) {
          this._lastRemoved = { zone: 'equip', zoneKey: SGS.Equipment.slotOf(c) || 'weapon' };
          return c;
        }
      }
      this._lastRemoved = null;
      return null;
    }

    /** 最近一次 removeCard 的来源（供 Game.discardConsumed 结算失去装备） */
    lastRemovedZone() { return this._lastRemoved || null; }
    clearRemovedZone() { this._lastRemoved = null; }

    findByType(type) {
      return this.hand.filter((c) => c.type === type);
    }

    /**
     * 弃牌阶段的手牌上限 = 当前体力 + 锁定技加成。
     * 【绝境】通过 handLimitBonus 钩子 +2（满血 2 体力时上限 4）；
     * 未实现该钩子的角色 base=0，行为与旧版「上限 = 体力」完全一致。
     */
    get handLimit() {
      const bonus = this.hook('handLimitBonus', 0) || 0;
      return Math.max(0, this.hp + bonus);
    }

    isDead() {
      return this.hp <= 0;
    }

    /** 回合开始时重置 per-turn 状态（含【酒】的限用与伤害加成） */
    resetTurn() {
      this.shaUsed = 0;
      this.jiuUsed = false;
      this.jiuBuff = false;
      // ★ 角色技能的每回合状态（渐营 / 藏拙 / 矢北）
      this.playLog = [];
      this.trickUsedThisTurn = false;
      this.jianyingUsed = false;
      this.turnDamageCount = 0;
      this.shibeiHealed = false;
    }
  }

  SGS.Player = Player;
  SGS.DEFAULT_HOOKS = DEFAULT_HOOKS;
})(typeof window !== 'undefined' ? window : globalThis);
