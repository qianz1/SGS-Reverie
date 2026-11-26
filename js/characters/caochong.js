/**
 * characters/caochong.js
 * 【魏】曹冲 —— 体力 3，称号「聪察岐嶷」，技能「称象 / 仁心」。
 *
 * 技能契约（与庞统 / 张春华 / 杜预同款：角色文件内聚实现）：
 *   称象（自动触发，不询问）
 *     · 受到伤害后（每次伤害结算一次）亮出牌堆顶 4 张牌，
 *       获得其中任意张「点数和 ≤ 13」的牌。
 *     · 若以此法获得的牌点数和恰好为 13，则【下次】发动称象多亮出一张牌
 *       （4 → 5，只多一张，不叠加）。
 *   仁心（其他角色濒死时的可选救援）
 *     · 一名其他角色进入濒死状态时，可翻面 + 弃置一张装备牌，
 *       然后令该角色回复体力至 1 点。
 *     · 由 Game.brink() → askBrinkRescue() 在濒死结算开始时询问。
 *
 * 翻面状态存在 player.flipped（Player.flip / restoreGeneral），
 * 轮到背面朝上的角色回合开始时先翻回正面、再跳过整个回合（Game.runTurn）。
 *
 * 立绘 assets/characters/WEI-CaoChong.webp（core.js 按势力自动补前缀；
 * 素材缺失时 UI 的 probeArt() 回退到 CSS 绘制，不影响规则）。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Characters = SGS.Characters || (SGS.Characters = {});

  const EQUIP_KEYS = ['weapon', 'armor', 'horsePlus', 'horseMinus'];

  /** 该玩家可弃置的「装备牌」：装备区四槽 + 手牌里的装备牌 */
  function equipCards(player) {
    if (!player) return [];
    const slotCards = (player.equips ? EQUIP_KEYS : [])
      .map((k) => player.equips[k]).filter(Boolean);
    const handEquips = (player.hand || []).filter(
      (c) => c && SGS.Cards && SGS.Cards.isEquip && SGS.Cards.isEquip(c.type));
    return slotCards.concat(handEquips);
  }

  /**
   * 称象的 AI 决策：在所有子集里挑「点数和 ≤ 13 且最大」的一组，
   * 和恰好 13 时优先（会换来下次多亮一张）。
   * 亮出的牌不多（4~5 张），直接枚举 2^n 即可，结果稳定且最优。
   */
  function aiChoose(cards) {
    const n = cards.length;
    let best = [], bestSum = -1, bestExact = false;
    for (let mask = 0; mask < (1 << n); mask++) {
      const pick = [];
      let sum = 0;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) { pick.push(cards[i]); sum += SGS.Cards.pointOf(cards[i]); }
      }
      if (sum > 13) continue;
      const exact = sum === 13;
      // 先比「是否恰好 13」，再比点数和，最后比张数（多拿一张更划算）
      if (exact && !bestExact) { best = pick; bestSum = sum; bestExact = exact; continue; }
      if (exact === bestExact && (sum > bestSum ||
          (sum === bestSum && pick.length > best.length))) {
        best = pick; bestSum = sum; bestExact = exact;
      }
    }
    return best;
  }

  /** 玩家侧：交给亮牌多选面板；AI / 假界面走 aiChoose */
  async function chooseCards(game, player, cards) {
    if (!cards.length) return [];
    if (SGS.isDecider(player) && game.ui && typeof game.ui.waitReveal === 'function') {
      const ids = await game.ui.waitReveal(game, player, cards, {
        title: '称象',
        note: '亮出牌堆顶 ' + cards.length + ' 张',
        limit: 13,
        confirmLabel: '获得'
      }) || [];
      const picked = [];
      ids.forEach((id) => {
        const c = cards.find((x) => String(x.id) === String(id));
        if (c && picked.indexOf(c) < 0) picked.push(c);
      });
      return picked;
    }
    return aiChoose(cards);
  }

  /**
   * 把称象获得的牌收进手牌。
   *
   * ★ 落点必须按「谁获得」来分，不能一律走 flipInsertIntoHand：
   *   那个方法的落点写死是本机 #me-hand（它是给「本地玩家摸牌 / 得牌」用的）。
   *   对手的曹冲发动称象时如果也走它，牌就会飞进【我的手牌区】——
   *   正是「对方发动称象，获得牌的动画飞到我这边」的原因。
   *   · 本地真人 → flipInsertIntoHand：旧牌 FLIP 让位 + 正面飞进最终格子
   *   · AI / 远端角色 → presentCard + dest:'ai-hero'：与摸牌 / 顺手牵羊 /
   *     五谷丰登同一套落点（本机看是角色框；客机由联机层按获得者翻回
   *     自己的手牌区），正反面由 toPlayer 判定，并且这次飞牌会广播给客机。
   */
  async function gainToHand(game, player, cards) {
    if (!cards || !cards.length) return;
    const commit = () => {
      cards.forEach((c) => { if (player.hand.indexOf(c) < 0) player.hand.push(c); });
      if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
    };

    // ① 本地真人玩家：插入手牌动画（一批一次性完成让位 + 逐张错峰飞入）
    if (player && player.isHuman && game.ui &&
        typeof game.ui.flipInsertIntoHand === 'function' &&
        typeof document !== 'undefined' && document.querySelectorAll) {
      const ok = await game.ui.flipInsertIntoHand(cards, player, game, { commit });
      if (!ok) commit();
      return;
    }

    // ② 其他角色：背面飞向其角色框（联机时由 toPlayer 决定谁能看正面）
    if (game.ui && typeof game.ui.flyCard === 'function' &&
        typeof game.presentCard === 'function') {
      await Promise.all(cards.map((c, i) => game.presentCard(c, player, {
        from: 'table',
        dest: 'ai-hero',
        toPlayer: player,
        faceDown: true,
        stackIndex: i,
        stackCount: cards.length
      })));
      commit();
      return;
    }

    commit();
  }

  /** 角色数据 */
  const data = {
    id: 'caochong',
    name: '曹冲',
    displayName: '曹冲',
    introName: '曹冲',
    title: '聪察岐嶷',
    faction: '魏',
    image: 'CaoChong.webp',    // → WEI-CaoChong.webp
    maxHp: 3,
    avatar: '冲',
    gender: 'male'
  };

  /**
   * 发动一次【称象】：亮出牌堆顶 N 张，获得其中点数和 ≤ 13 的牌。
   * 未获得的进弃牌堆；点数和恰好 13 → 下次多亮一张（一次性，不叠加）。
   * @returns {Promise<boolean>} 是否真的亮牌结算了（询问时选「不发动」→ false）
   */
  async function chengxiangOnce(game, player) {
    if (!game || !game.deck || typeof game.deck.draw !== 'function') return false;
    const extra = Math.max(0, player.chengxiangExtra || 0) ? 1 : 0;
    const n = 4 + extra;

    // ★ 顶栏「称象自动发动」默认不勾：到点改为询问是否发动（只问真人，
    //   AI / 托管由 ai.askOptional 决策，行为与勾选后一致）。
    if (!SGS.skillAutoEnabled('称象') && SGS.isDecider(player)) {
      const ok = await game.askOptional(player, {
        name: '称象',
        context: 'chengxiang',
        desc: '【称象】：是否亮出牌堆顶 ' + n + ' 张牌，' +
          '获得其中任意张点数和不超过 13 的牌？' +
          (extra ? '（上次点数和为13，本次多亮一张）' : ''),
        yes: '发动', no: '不发动'
      });
      if (!ok) {
        if (SGS.log) SGS.log(player.name + ' 放弃发动【称象】。', 'sys');
        return false;
      }
    }

    // 多亮一张是「下次」的一次性效果，先清掉，这次凑到 13 再重新置位
    player.chengxiangExtra = 0;

    const cards = game.deck.draw(n);
    if (!cards.length) return false;

    if (typeof game.announceSkill === 'function') game.announceSkill(player, '称象');
    if (SGS.log) {
      SGS.log(player.name + ' 亮出牌堆顶 ' + cards.length + ' 张牌（【称象】' +
        (extra ? '，上次点数和为13，本次多亮一张' : '') + '）。', 'sys');
    }
    if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
    // ★【称象】的效果就是「亮出牌堆顶的牌」——亮牌对全场公开，
    //   所以先摊一块只读面板给所有人看（联机时经 FX_METHODS 广播）。
    //   本地决策者随后由 waitReveal 弹出的交互面板盖在它上面（同一批牌）。
    if (game.ui && typeof game.ui.showRevealPublic === 'function') {
      game.ui.showRevealPublic(game, player, cards, {
        title: '称象',
        note: '亮出牌堆顶 ' + cards.length + ' 张牌'
      });
    }
    await SGS.sleep(140);

    const got = await chooseCards(game, player, cards);
    const gotIds = got.map((c) => String(c.id));
    const rest = cards.filter((c) => gotIds.indexOf(String(c.id)) < 0);

    // 只读面板上标出被拿走的牌，稍作停留再收起（看不清等于没亮）
    if (game.ui && typeof game.ui.markRevealTaken === 'function') {
      game.ui.markRevealTaken(gotIds);
    }

    if (got.length) {
      await gainToHand(game, player, got);
    }
    if (rest.length && typeof game.deck.discard === 'function') {
      game.deck.discard(rest);
    }
    // 亮牌面板收尾：停留一会儿让所有人都看清，再收起（决策者那条路已自己关掉）
    if (game.ui && typeof game.ui.closeRevealPanel === 'function') {
      await SGS.sleep(520);
      game.ui.closeRevealPanel();
    }

    const sum = got.reduce((s, c) => s + (SGS.Cards.pointOf(c) || 0), 0);
    if (SGS.log) {
      SGS.log(player.name + ' 获得其中 ' + got.length + ' 张' +
        (got.length ? '（' + got.map((c) => c.name).join('、') + '，点数和 ' + sum + '）' : '') +
        '，其余 ' + rest.length + ' 张置入弃牌堆。', 'sys');
    }
    if (sum === 13) {
      player.chengxiangExtra = 1;
      if (SGS.log) {
        SGS.log('【称象】获得的牌点数和恰好为13：' + player.name +
          ' 下次发动【称象】多亮出一张牌。', 'sys');
      }
    }
    if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
    return true;
  }

  const skill = {
    name: '称象',
    titles: '称象 · 仁心',
    desc: '称象：当你受到1点伤害后，你可以亮出牌堆顶的四张牌，获得其中任意张' +
      '点数和小于等于13的牌；若获得的牌点数和恰好为13，你下次发动“称象”多亮出一张牌。｜' +
      '仁心：当一名其他角色进入濒死状态时，你可以翻面并弃置一张装备牌，' +
      '然后令该角色回复体力至1点。',
    active: false,

    /**
     * ① 称象：受到伤害后亮出牌堆顶 4 张（上次凑 13 则 5 张），
     *    获得其中任意张点数和 ≤ 13 的牌；未获得的进弃牌堆。
     * ★「受到 1 点伤害后」= 按点数拆成 x 次独立发动：受到 2 点伤害就结算
     *   两次称象（各问一次 / 各亮一次牌），而不是只发动一次。
     */
    async onDamaged(game, player, count, info) {
      const amount = (info && info.amount) || 0;
      if (!player || player.dead || amount < 1) return;
      const times = Math.floor(amount);
      for (let i = 0; i < times; i++) {
        if (player.dead || !game || game.over) return;
        await chengxiangOnce(game, player);
      }
    },

    /**
     * ② 仁心：其他角色进入濒死时询问。翻面 + 弃一张装备牌 → 该角色回复至 1 点。
     *    由 Game.brink() 在濒死结算开始时调用（Game.askBrinkRescue）。
     * @returns {Promise<boolean>} 是否发动
     */
    async onOtherBrink(game, player, dying) {
      if (!player || !dying || player === dying) return false;
      if (player.dead || dying.dead || dying.hp > 0) return false;
      const equips = equipCards(player);
      if (!equips.length) return false;          // 没有装备牌，发动不了

      // AI 只救自己人（1v1 里不会去救对手）；真人由玩家自己决定
      if (!SGS.isDecider(player) && !!player.isHuman !== !!dying.isHuman) return false;

      const ok = await game.askOptional(player, {
        name: '仁心',
        context: 'renxin',
        desc: '【仁心】：' + dying.name + ' 进入濒死状态，是否翻面并弃置一张装备牌，' +
          '令其回复体力至 1 点？',
        yes: '发动', no: '不发动'
      });
      if (!ok) return false;

      // 选一张装备牌弃置（真人可点装备区 / 手牌里的装备牌，AI 取第一张）
      let card = equips[0];
      if (SGS.isDecider(player) && game.ui && typeof game.ui.waitPick === 'function') {
        const id = await game.ui.waitPick(player, game, {
          need: 1, allowEquip: true,
          filter: (c) => !!(c && SGS.Cards.isEquip && SGS.Cards.isEquip(c.type)),
          confirmLabel: '弃置装备',
          hint: '【仁心】：请点选一张装备牌弃置。'
        });
        const found = equips.find((c) => String(c.id) === String(id));
        if (found) card = found;
      }
      if (!card) return false;

      if (typeof player.flip === 'function') player.flip();
      else player.flipped = !player.flipped;

      if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
      await game.presentCard(card, player, { dest: 'showcase', note: '仁心弃置' });
      await game.discardConsumed(player, card);

      // 回复体力至 1 点（可能要从负数回到 1，所以补的是 1 - hp）
      if (dying.hp < 1) {
        const need = 1 - dying.hp;
        if (typeof game.healPlayer === 'function') game.healPlayer(dying, need);
        else dying.hp = 1;
      }
      if (SGS.log) {
        SGS.log(player.name + ' 发动【仁心】：翻面并弃置【' + card.name +
          '】，令 ' + dying.name + ' 回复体力至 1 点。', 'sys');
      }
      if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
      return true;
    }
  };

  Characters.caochong = Object.assign({}, data, { skill: skill });
})(typeof window !== 'undefined' ? window : globalThis);
