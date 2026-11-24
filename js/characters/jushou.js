/**
 * characters/jushou.js
 * 【群】沮授 —— 体力 3，称号「监军谋国」，双技能「渐营」+「矢北」。
 *
 * 技能契约（角色文件内聚实现，主循环 / UI / AI 只认统一钩子）：
 *   渐营（含「可以」，主动转化走右下技能按钮）
 *     ① 出牌阶段每使用一张牌，若与此阶段「上一张使用的牌」花色或点数相同，
 *        **直接摸一张牌、不询问**：Game.noteUsedCard() 把 current / previous
 *        交给 onPlayCard()，这里判断后调用 Game.drawCards()（同款摸牌动画）。
 *     ② 出牌阶段限一次，可将一张牌当「任意一张基本牌」使用：
 *        六种基本牌 = 杀 / 闪 / 桃 / 酒 / 火杀 / 雷杀（Cards.BASIC_TYPES）。
 *        ★ 描述写「牌」= 手牌 + 装备区（不含判定区），技能选牌模式下
 *          可直接点装备栏选取素材，离场走 Game.discardConsumed()。
 *        玩家点技能按钮 → 选牌 → 在六种里选一种 → Game.useConvertedBasic()；
 *        AI 用 basicChoice() 直接挑一种，走同一个入口。
 *        转化后的牌**点数与原牌一致**；若本阶段上一张使用的牌有花色，
 *        则此牌花色视为与上一张相同（花色覆盖在 useConvertedBasic 里完成）。
 *   矢北（锁定技）
 *     Game.damage() 每次伤害后回调 onDamaged(game, player, count)：
 *       本回合第 1 次 → 回复 1 点体力；
 *       此后本回合每次（第 2、3、4… 次）→ 失去 1 点体力，没有次数上限。
 *       计数由 Game.runTurn() 每回合清零；失去体力可能触发濒死。
 *
 * 立绘：assets/characters/QUN-JuShou.webp（core.js 自动补势力前缀）。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Characters = SGS.Characters || (SGS.Characters = {});

  const BASIC = SGS.Cards && SGS.Cards.BASIC_TYPES
    ? SGS.Cards.BASIC_TYPES : ['sha', 'shan', 'tao', 'jiu', 'huosha', 'leisha'];

  /** —— 角色数据 —— */
  const data = {
    id: 'jushou',
    name: '沮授',
    displayName: '沮授',
    title: '监军谋国',
    faction: '群',
    image: 'JuShou.webp',   // → QUN-JuShou.webp
    maxHp: 3,
    avatar: '沮',
    gender: 'male'
  };

  /** —— 技能实现 —— */
  const skill = {
    name: '渐营',
    titles: '渐营 · 矢北',
    desc: '渐营：当你于出牌阶段使用牌时，若此牌与你于此阶段使用的上一张牌花色或点数相同，则你可以摸一张牌；' +
          '出牌阶段限一次，你可以将一张牌当任意一张基本牌使用，若你于本阶段使用的上一张牌有花色，则此牌花色视为与该牌相同。｜' +
          '矢北（锁定技）：你每回合第一次受到伤害后，回复1点体力，此后你本回合每次受到伤害后均失去1点体力。',
    active: true,

    /** ② 出牌阶段限一次的「当任意基本牌」 */
    conversions: [
      {
        from: 'any', to: 'basic', scenes: ['play'], skill: '渐营',
        // ★【青龙偃月刀】追加杀的时机仍在出牌阶段，选牌界面用 play 场景
        //   + need ['sha','basic'] 放行，无需另设场景（否则龙魂 / 龙胆
        //   这些 scenes:['play','respond'] 的转化会在青龙界面被误排除）。
        label: '当任意基本牌'
      }
    ],

    /**
     * 复核「这张牌能否当作 to 使用」。
     * 只放行 to==='basic'（任意牌都可当素材），其余一律 false ——
     * 避免渐营的万能转化误伤 canUseAsSha / 无懈响应等其它判定。
     */
    asType(player, card, to) {
      return !!card && to === 'basic';
    },

    /**
     * ① 渐营摸牌：与上一张使用的牌同花色或同点数 → 直接摸一张，不询问。
     * current / previous 都是 {card, suit, rank, asType}，花色已按「视为」规则覆盖。
     */
    async onPlayCard(game, player, current, previous) {
      if (!previous) return;
      const sameSuit = !!current.suit && !!previous.suit &&
        current.suit === previous.suit;
      const sameRank = !!current.rank && !!previous.rank &&
        String(current.rank) === String(previous.rank);
      if (!sameSuit && !sameRank) return;
      if (SGS.log) {
        SGS.log(player.name + ' 发动【渐营】：本张与上一张使用的牌' +
          (sameSuit ? '花色相同（' + current.suit + '）' : '点数相同（' + current.rank + '）') +
          '，摸一张牌。', 'sys');
      }
      const got = await game.drawCards(player, 1);
      if (SGS.log) SGS.log(player.name + '【渐营】摸了 ' + got.length + ' 张牌。', 'sys');
    },

    /** AI 用：渐营限一次转化时选哪种基本牌 */
    basicChoice(game, player) {
      // 有能打到的目标且还有杀次数 → 当【杀】
      const targets = (game && typeof game.listTargets === 'function')
        ? game.listTargets(player, { type: 'sha' }, 'sha') : [];
      if (player.canPlaySha() && targets.length) return 'sha';
      // 受伤 → 当【桃】
      if (player.hp < player.maxHp && player.hand.some((c) => c.id)) return 'tao';
      // 还有杀次数且没喝过酒 → 当【酒】
      if (player.canPlaySha() && !player.jiuUsed) return 'jiu';
      return null;
    },

    /** 矢北：本回合第 1 次受伤回 1 血，此后每次受伤都失去 1 点体力（无次数上限） */
    async onDamaged(game, player, count, info) {
      if (count === 1) {
        if (player.hp >= player.maxHp) {
          if (SGS.log) SGS.log(player.name + ' 发动【矢北】，但体力已满，无需回复。', 'sys');
          return;
        }
        // ★ 统一加血入口：矢北第一次受伤回血也走 07 号加血音效
        if (typeof game.healPlayer === 'function') {
          game.healPlayer(player, 1);
        } else {
          player.hp = Math.min(player.maxHp, player.hp + 1);
          try { if (SGS.Audio && SGS.Audio.playHeal) SGS.Audio.playHeal(); } catch (e) {}
        }
        if (SGS.log) {
          SGS.log(player.name + ' 发动【矢北】：本回合第一次受到伤害，回复 1 点体力，至 ' +
            player.hp + '/' + player.maxHp + '。', 'heal');
        }
        game.ui.render(game);
        await SGS.sleep(220);
        return;
      }
      // ★ 此后每一次（第 2、3、4… 次）都再失去 1 点体力，不再只算第二次
      player.hp -= 1;
      // 直接失血使 X 变大 → 复查【伤逝】的「手牌数 < X」条件
      if (typeof game.checkHandBelowX === 'function') {
        await game.checkHandBelowX(player);
      }
      if (SGS.log) {
        SGS.log(player.name + ' 发动【矢北】：本回合第 ' + count +
          ' 次受到伤害，失去 1 点体力，至 ' +
          Math.max(0, player.hp) + '/' + player.maxHp + '。', 'dmg');
      }
      game.ui.render(game);
      await SGS.sleep(220);
    },

    // 渐营不改变出杀次数
    shaLimit(player, defaultLimit) {
      return defaultLimit;
    }
  };

  Characters.jushou = Object.assign({}, data, { skill: skill });
})(typeof window !== 'undefined' ? window : globalThis);
