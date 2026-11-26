/**
 * characters/duyu.js
 * 【晋】杜预 —— 体力 4，称号「文成武德」，技能「三陈 / 昭讨 / 破竹」。
 *
 * 技能契约（与庞统 / 张春华同款：角色文件内聚实现，主循环 / UI / AI 只认统一钩子）：
 *   三陈（出牌阶段限一次，主动技按钮）
 *     · 令一名角色摸三张牌，然后弃置三张牌（由该角色自己选）。
 *     · 若其以此法弃置的三张牌类型（基本 / 锦囊 / 装备）均不同：
 *         其摸一张牌，本技能视为未发动（同回合可再用），
 *         但本回合不能再指定该角色为目标。
 *       类型有重复 → 本回合【三陈】已发动（不能再点）。
 *     · 每回合准备阶段重置 sanchenUsed / sanchenTargets / sanchenNoTarget。
 *   昭讨（觉醒技，准备阶段）
 *     · 本局发动【三陈】累计 ≥ 3 次 → 减 1 点体力上限（当前体力随之封顶），
 *       获得【破竹】。只觉醒一次。
 *   破竹（☆ 昭讨获得，转化型主动技）
 *     · 将一张**手牌**当【出其不意】使用（素材仅限手牌，不含装备区）。
 *     · 若这张【出其不意】未造成伤害（同花色 / 被无懈抵消），
 *       本回合【破竹】失效（pozuDisabled）。
 *
 * 立绘 assets/characters/JIN-DuYu.webp（core.js 按势力自动补前缀；
 * 素材缺失时 UI 的 probeArt() 回退到 CSS 绘制，不影响规则）。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Characters = SGS.Characters || (SGS.Characters = {});

  /** 座位键：优先用全局唯一的座位号，没有座位时退回 players 下标 */
  function seatKey(player, game) {
    if (player && player.seat != null) return String(player.seat);
    const i = (game && game.players ? game.players : []).indexOf(player);
    return 'i' + i;
  }

  /**
   * 令某角色选 n 张「牌」弃置（手牌 + 装备区，不含判定区）。
   * ★【三陈】的描述是「弃置三张牌」，没有限定手牌 —— 装备区的牌同样可以
   *   弃置（与贯石斧 / 寒冰剑共用 waitPick 的 allowEquip 多选区）。
   *   人类走统一选牌界面，AI 仍优先弃手牌（保住自己的装备）。
   */
  async function chooseDiscards(game, player, n, hint) {
    const hand = (player && player.hand) || [];
    const equips = (player && player.equips)
      ? ['weapon', 'armor', 'horsePlus', 'horseMinus']
        .map((k) => player.equips[k]).filter(Boolean)
      : [];
    const pool = hand.concat(equips);
    const need = Math.min(n, pool.length);
    if (!need) return [];
    let ids = null;
    if (SGS.isDecider(player) && game.ui && typeof game.ui.waitPick === 'function') {
      ids = await game.ui.waitPick(player, game, {
        need: need, allowEquip: true, confirmLabel: '弃置', hint: hint
      });
    } else if (game.ai && typeof game.ai.pickDiscards === 'function') {
      ids = game.ai.pickDiscards(player, need);
    }
    if (!ids) ids = [];
    if (!Array.isArray(ids)) ids = [ids];
    const picked = [];
    ids.forEach((id) => {
      const c = pool.find((x) => String(x.id) === String(id));
      if (c && picked.indexOf(c) < 0) picked.push(c);
    });
    // ★ 强制弃满：选牌界面若因为异常返回不足（取消 / 脏数据），依次从
    //   手牌、再从装备区补齐，避免「该弃三张却只弃一张」破坏规则。
    for (const c of pool) {
      if (picked.length >= need) break;
      if (picked.indexOf(c) < 0) picked.push(c);
    }
    return picked.slice(0, need);
  }

  /** 角色数据 */
  const data = {
    id: 'duyu',
    name: '杜预',
    displayName: '杜预',
    introName: '杜预',
    title: '文成武德',
    faction: '晋',
    image: 'DuYu.webp',       // → JIN-DuYu.webp
    maxHp: 4,
    avatar: '杜',
    gender: 'male'
  };

  /**
   * 派生技能【破竹】。Player.acquireSkill() 会把它合并进该玩家专属的
   * skill 视图（conversions 追加、titles / desc 拼接、asType 覆盖）。
   */
  const fragments = {
    '破竹': {
      name: '破竹',
      titles: '☆破竹',
      desc: '☆破竹：出牌阶段，你可以将一张手牌当【出其不意】使用；' +
        '若此【出其不意】未造成伤害，本回合此技能失效。',
      /** 素材只认手牌：装备区的牌（同一对象不在 hand 里）不能用来发动 */
      asType(player, card, to) {
        if (to !== 'chubuyi') return false;
        return !!(player && card && (player.hand || []).indexOf(card) >= 0);
      },
      conversions: [
        { from: 'any', to: 'chubuyi', scenes: ['play'], skill: '破竹',
          // ★ handOnly：素材只认手牌（装备区的牌不能转化）。UI 的选牌引导
          //   据此写「点选一张手牌发动」，而不是笼统的「一张牌」。
          handOnly: true,
          // ★ 破竹要选目标（出其不意）：技能语音等目标选定后再播，
          //   选素材 / 点技能按钮时不播。由 Tricks.use 统一在目标确定后发声。
          announceAfterTarget: true,
          label: '一张手牌当【出其不意】' }
      ],
      /** 【出其不意】结算结果回调（由 tricks.js 的 resolveChubuyi 调用） */
      onChubuyiResult(player, dealt) {
        if (dealt) return;
        player.pozhuDisabled = true;
        if (SGS.log) {
          SGS.log(player.name + ' 的【出其不意】未造成伤害，【破竹】本回合失效。', 'sys');
        }
      }
    }
  };

  /** —— 基础技能 —— */
  const skill = {
    name: '三陈',
    titles: '三陈 · 昭讨',
    // 选将卡上把【破竹】以 ☆ 列出；局内 heroInfoHTML 会过滤掉未获得的 ☆ 条目
    desc: '三陈：出牌阶段限一次，你可以令一名角色摸三张牌，然后弃置三张牌。' +
          '若其以此法弃置的牌类型均不同，其摸一张牌，本技能视为未发动且本回合不能指定其为目标。｜' +
          '昭讨（觉醒技）：准备阶段，若你本局发动过至少3次“三陈”，你减少1点体力上限，并获得“破竹”。｜' +
          fragments['破竹'].desc,
    active: true,

    fragments: fragments,

    /** 准备阶段：重置三陈的回合状态 + 昭讨觉醒判定 */
    onPrepare(game, player) {
      player.sanchenUsed = false;
      player.sanchenTargets = {};
      player.sanchenNoTarget = false;
      player.pozhuDisabled = false;

      if (player.zhaotaoAwakened) return;
      if ((player.sanchenCount || 0) < 3) return;
      player.zhaotaoAwakened = true;
      const before = player.maxHp;
      player.maxHp = Math.max(0, (player.maxHp || 0) - 1);
      if (player.hp > player.maxHp) player.hp = player.maxHp;
      if (typeof player.acquireSkill === 'function') player.acquireSkill('破竹');
      if (typeof game.announceSkill === 'function') {
        game.announceSkill(player, '昭讨');
      }
      if (SGS.log) {
        // 不写「发动【昭讨】」：日志兜底会再播一次技能大字 / 语音
        SGS.log(player.name + ' 觉醒【昭讨】：体力上限 ' + before + '→' +
          player.maxHp + '，获得【破竹】。', 'sys');
      }
      if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
      if (game.ui && typeof game.ui.refreshActions === 'function') game.ui.refreshActions();
    },

    actions: [
      {
        name: '三陈',
        scenes: ['play'],
        once: false,   // 「限一次」由 player.sanchenUsed 管（成功时会被重置）
        // ★ 语音 / 技能大字在「选完目标」之后由 run() 自己播一次，
        //   点按钮时先不播 —— 否则取消选目标也会白响。
        announce: false,
        usable(player) {
          return !player.sanchenUsed && !player.sanchenNoTarget;
        },
        aiChoice(game, player, scene) {
          if (!game || !player || !SGS.canUseSkillAction(player, '三陈', scene)) return null;
          const banned = player.sanchenTargets || {};
          const has = (game.players || []).some(
            (p) => p && !p.isDead() && !banned[seatKey(p, game)]);
          return has ? '三陈' : null;
        },
        async run(game, player) {
          const banned = player.sanchenTargets || (player.sanchenTargets = {});
          const all = (game.players || []).filter((p) => p && !p.isDead());
          const cands = all.filter((p) => !banned[seatKey(p, game)]);
          if (!cands.length) {
            player.sanchenNoTarget = true;
            return false;
          }

          // 目标可以是自己：AI 优先把自己当「手牌整理」对象（对对手是净帮忙）
          const probe = {
            id: SGS.uid('virtual'), type: 'sanchen', name: '三陈',
            suit: '', rank: '', color: null, category: 'trick'
          };
          let target = null;
          if (SGS.isDecider(player)) {
            target = await game.selectTarget(player, probe, cands);
          } else {
            target = cands.indexOf(player) >= 0 ? player : cands[0];
            await SGS.sleep(60);
          }
          if (!target) return false;

          // ★ 目标已确定 → 现在才播【三陈】的技能大字 / 语音。
          if (typeof game.announceSkill === 'function') {
            game.announceSkill(player, '三陈');
          }

          player.sanchenCount = (player.sanchenCount || 0) + 1;
          if (SGS.log) {
            // 刻意不写「发动【三陈】」：技能大字 / 语音已经在上面播过，
            // 这里再写一次会让日志兜底重播。
            SGS.log(player.name + ' 的【三陈】目标为 ' + target.name + '：' +
              '令其摸三张牌，然后弃置三张牌。', 'sys');
          }

          await game.drawCards(target, 3);
          if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);

          const cards = await chooseDiscards(game, target, 3,
            '【三陈】：请点选 3 张牌弃置（手牌或装备区的牌），然后确认。');
          if (cards.length) {
            await game.presentCards(cards, target, {
              dest: 'showcase', note: '三陈弃置',
              from: target.isHuman ? undefined : 'hero'
            });
            for (const c of cards) await game.discardConsumed(target, c);
            if (SGS.log) {
              SGS.log(target.name + ' 弃置 ' + cards.length + ' 张：' +
                (cards.map((c) => c.name).join('、') || '无') + '。', 'sys');
            }
            if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
          }

          // 类型（基本 / 锦囊 / 装备）均不同 → 摸一张 + 视为未发动 + 封锁该目标
          const kinds = cards.map((c) => (c && c.category) || 'basic');
          const allDiff = cards.length === 3 &&
            kinds.every((k, i) => kinds.indexOf(k) === i);
          if (allDiff) {
            await game.drawCards(target, 1);
            player.sanchenUsed = false;
            banned[seatKey(target, game)] = true;
            player.sanchenNoTarget = !all.some(
              (p) => !p.isDead() && !banned[seatKey(p, game)]);
            if (SGS.log) {
              SGS.log(target.name + ' 以此法弃置的牌类型均不同：摸一张牌；' +
                '【三陈】视为未发动，本回合不能再指定 ' + target.name + ' 为目标。', 'sys');
            }
          } else {
            player.sanchenUsed = true;
            if (SGS.log) {
              SGS.log('【三陈】弃置的牌类型有重复，本回合不能再发动。', 'sys');
            }
          }
          if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
          return true;
        }
      }
    ],

    // 三陈 / 昭讨 / 破竹都不改变出杀次数
    shaLimit(player, defaultLimit) { return defaultLimit; }
  };

  Characters.duyu = Object.assign({}, data, { skill: skill });
})(typeof window !== 'undefined' ? window : globalThis);
