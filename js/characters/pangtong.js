/**
 * characters/pangtong.js
 * 【蜀】庞统 —— 体力 3，基础技能「连环 / 涅槃」，涅槃后三选一获得
 * 「火计」「看破」「八阵」中的一个。
 *
 * 技能契约（与卧龙诸葛 / 沮授同款：角色文件内聚实现，主循环 / UI / AI 只认统一钩子）：
 *   连环（主动转化走右下技能按钮）
 *     · 一张♣「牌」当【铁索连环】使用或重铸：
 *       conversion ♣→tiesuolianhuan（scenes:['play']，reforge:true），
 *       asType 只按 ♣ 花色放行，素材取自 SGS.Zones.conversionCards()
 *       （手牌 + 装备区，不含判定区），离手由 Game.discardConsumed() 处理。
 *     · chainTargetBonus(player)=1：使用【铁索连环】时目标上限由 2 变 3。
 *       普通【铁索连环】也享受，不仅限于转化出来的那张。
 *   涅槃（限定技，主动技按钮 → 一次性行动）
 *     · scenes:['play','brink']，actions[0] 由 Game.useSkillAction() 调度；
 *       每局一次（usedSkillActions['涅槃']），出牌阶段随时可点，濒死时
 *       在 waitBrink 的技能位可点（Game.brink() 识别 skillAction 回传）。
 *     · 结算顺序：弃置三个区域（手牌 / 装备 / 判定）的所有牌 → 复原武将牌
 *       （当前只清连环状态）→ 摸三张 → 体力回复至 3 → 三选一获得派生技能。
 *   派生技能（fragments，由 Player.acquireSkill() 合并进该玩家自己的 skill）：
 *     · 火计：红牌当【火攻】+ huogongRule（看目标手牌、弃同色手牌）；
 *     · 看破：黑牌当【无懈可击】+ wuXieUnrespondable；
 *     · 八阵：virtualArmor → 视为装备【八卦阵】。
 *   三选一互斥，未获得的派生技能不会进入 titles / desc / 按钮列表。
 *
 * 立绘 assets/characters/SHU-PangTong.webp（core.js 按势力自动补前缀）。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Characters = SGS.Characters || (SGS.Characters = {});

  const CLUB = '\u2663';   // ♣

  /** 角色数据 */
  const data = {
    id: 'pangtong',
    name: '庞统',
    displayName: '庞统',
    introName: '庞统',
    title: '凤雏',
    faction: '蜀',
    image: 'PangTong.webp',       // → SHU-PangTong.webp
    maxHp: 3,
    avatar: '庞',
    gender: 'male'
  };

  /** 是否拥有某个派生技能（兼容测试里不带 hasSkill 的伪 player） */
  function owns(player, name) {
    if (!player) return false;
    if (typeof player.hasSkill === 'function') return player.hasSkill(name);
    const sk = player.skill || data.skill;
    return String((sk && sk.titles) || '').indexOf(name) >= 0;
  }

  /** 涅槃可获得的三个技能，顺序即 UI 选项顺序 */
  const NIRVANA_CHOICES = [
    { label: '获得【八阵】', value: '八阵', desc: '锁定技：无防具时视为装备【八卦阵】。' },
    { label: '获得【火计】', value: '火计', desc: '红色牌当【火攻】，火攻改为观看手牌后展示一张、弃同色手牌。' },
    { label: '获得【看破】', value: '看破', desc: '黑色牌当【无懈可击】，且不可被响应。' }
  ];

  /**
   * 三选一派生技能。Player.acquireSkill() 会把这些字段合并到该玩家专属的
   * skill 视图：conversions / actions 追加，titles / desc 拼接，其余覆盖。
   */
  const fragments = {
    '八阵': {
      name: '八阵',
      titles: '☆八阵',
      desc: '☆八阵（锁定技）：若你装备区里没有防具牌，你视为装备着【八卦阵】。',
      virtualArmor(player) {
        if (player && player.equips && player.equips.armor) return null;
        return SGS.Cards && SGS.Cards.equipOf
          ? SGS.Cards.equipOf('baguazhen') : { slot: 'armor', bagua: true };
      }
    },
    '火计': {
      name: '火计',
      titles: '☆火计',
      desc: '☆火计：你可以将一张红色牌当【火攻】使用。你的【火攻】改为你观看目标的手牌然后展示其中一张牌，你弃置与其展示牌颜色相同的手牌以造成伤害。',
      huogongRule: { peek: true, match: 'color' },
      buttonName(scene) { return scene === 'wuxie' ? '连环' : '火计'; },
      conversions: [
        { from: 'red', to: 'huogong', scenes: ['play'], skill: '火计',
          label: '红色牌当【火攻】' }
      ]
    },
    '看破': {
      name: '看破',
      titles: '☆看破',
      desc: '☆看破：你可以将一张黑色牌当【无懈可击】使用。你的【无懈可击】不能被响应。',
      buttonName(scene) { return scene === 'wuxie' ? '看破' : '连环'; },
      conversions: [
        { from: 'black', to: 'wuxiekeji', scenes: ['wuxie'], skill: '看破',
          label: '黑色牌当【无懈可击】' }
      ],
      wuXieUnrespondable() { return true; }
    }
  };

  /** —— 基础技能 —— */
  const skill = {
    name: '连环',
    titles: '连环 · 涅槃',
    // 选将卡上把所有派生技能以 ☆ 列出；局内 heroInfoHTML 会过滤掉未获得的 ☆ 条目
    desc: '连环：你可以将一张♣牌当【铁索连环】使用或重铸；你使用【铁索连环】可以多指定一名角色为目标。｜' +
          '涅槃（限定技）：出牌阶段或当你处于濒死状态时，你可以弃置区域里的所有牌，复原武将牌，摸三张牌，将体力回复至3点，然后获得“八阵”“火计”“看破”中的一个。｜' +
          fragments['八阵'].desc + '｜' + fragments['火计'].desc + '｜' + fragments['看破'].desc,
    active: true,

    /** 派生技能定义（UI 技能名白名单 / 涅槃选项从这里读） */
    fragments: fragments,
    nirvanaChoices: NIRVANA_CHOICES,

    buttonName() { return '连环'; },

    conversions: [
      {
        from: CLUB, to: 'tiesuolianhuan', scenes: ['play'], skill: '连环',
        reforge: true, label: '♣ 牌当【铁索连环】使用或重铸'
      }
    ],

    /** 复核转化：♣→铁索连环；派生技能按是否已获得放行 */
    asType(player, card, to) {
      if (!card) return false;
      if (to === 'tiesuolianhuan') return card.suit === CLUB;
      const red = card.color === 'red' ||
        card.suit === '\u2665' || card.suit === '\u2666';
      const black = card.color === 'black' ||
        card.suit === '\u2660' || card.suit === CLUB;
      if (to === 'huogong') return red && owns(player, '火计');
      if (to === 'wuxiekeji') return black && owns(player, '看破');
      return false;
    },

    /** 【连环】：使用【铁索连环】可多指定一名目标（2 → 3） */
    chainTargetBonus() { return 1; },
    chainTargetSkill: '连环',   // 多指定目标时的日志 / 语音技能名

    /** ——【涅槃】限定技：一次性行动 —— */
    actions: [
      {
        name: '涅槃',
        scenes: ['play', 'brink'],
        /** AI：濒死必用；出牌阶段仅在残血时使用，避免早期白白弃光手牌 */
        aiChoice(game, player, scene) {
          if (!game || !player || !SGS.canUseSkillAction(player, '涅槃', scene)) return null;
          if (scene === 'brink' || player.hp <= 1) return '涅槃';
          return null;
        },
        async run(game, player) {
          const parts = [];
          const entries = (SGS.Zones && typeof SGS.Zones.list === 'function')
            ? SGS.Zones.list(player) : [];
          // ① 弃置手牌区 / 装备区 / 判定区的全部牌
          if (entries.length) {
            const cards = entries.map((e) => e.card).filter(Boolean);
            if (typeof game.discardAllZoneCards === 'function') {
              await game.discardAllZoneCards(player, { note: '涅槃弃置' });
            } else {
              // 极端兜底：给把 Game 方法绑到普通对象上的专项自测用
              if (game.presentCards && typeof game.presentCards === 'function') {
                await game.presentCards(cards, player, { dest: 'showcase', note: '涅槃弃置' });
              }
              for (const e of entries) {
                const removed = (SGS.Zones && SGS.Zones.take)
                  ? SGS.Zones.take(player, e.id) : null;
                const c = removed && removed.card ? removed.card : removed;
                if (c && game.deck && typeof game.deck.discard === 'function') {
                  game.deck.discard(c);
                }
              }
            }
            parts.push('弃置 ' + cards.length + ' 张牌');
          } else {
            parts.push('区域内无牌可弃');
          }
          // ② 复原武将牌：翻回正面 + 解除连环状态（Player.restoreGeneral 统一收口）
          if (typeof player.restoreGeneral === 'function') {
            const done = player.restoreGeneral();
            if (done.length) parts.push(done.join('、'));
          } else if (player.chained) {
            player.chained = false;
            parts.push('解除连环状态');
          }
          if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);

          // ③ 摸三张牌
          const got = (typeof game.drawCards === 'function')
            ? await game.drawCards(player, 3) : [];
          parts.push('摸 ' + got.length + ' 张牌');

          // ④ 体力回复至 3 点（统一走 healPlayer，保证加血音效不漏）
          if (player.hp < 3) {
            if (typeof game.healPlayer === 'function') game.healPlayer(player, 3 - player.hp);
            else player.hp = 3;
          }
          parts.push('体力回复至 ' + player.hp + '/' + player.maxHp);

          if (SGS.log) {
            SGS.log(player.name + '【涅槃】：' + parts.join('，') + '。', 'sys');
          }
          if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
          await SGS.sleep(220);

          // ⑤ 三选一：获得的技能只合并到当前玩家，不影响另一名角色
          const picked = await game.askChoice(player, {
            name: '涅槃',
            desc: '【涅槃】：获得「八阵」「火计」「看破」中的一个？',
            choices: NIRVANA_CHOICES
          });
          const name = NIRVANA_CHOICES.some((c) => c.value === picked)
            ? picked : NIRVANA_CHOICES[0].value;
          if (typeof player.acquireSkill === 'function') player.acquireSkill(name);
          if (SGS.log) SGS.log(player.name + '【涅槃】获得【' + name + '】。', 'sys');
          if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
          // 立即刷新右下技能栏：刚获得的技能按钮当场出现，不等下一次 waitPlay
          if (game.ui && typeof game.ui.refreshActions === 'function') {
            game.ui.refreshActions();
          }
          await SGS.sleep(220);
          return true;
        }
      }
    ],

    // 连环 / 涅槃 / 三个派生技能都不改变出杀次数
    shaLimit(player, defaultLimit) { return defaultLimit; }
  };

  Characters.pangtong = Object.assign({}, data, { skill: skill });
})(typeof window !== 'undefined' ? window : globalThis);
