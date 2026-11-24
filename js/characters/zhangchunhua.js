/**
 * characters/zhangchunhua.js
 * 【魏】张春华 —— 体力 3，性别女，三技能「绝情 / 伤逝 / 翦灭」。
 *
 * 技能契约（与庞统 / 沮授同款：角色文件内聚实现，主循环 / UI / AI 只认统一钩子）：
 *   绝情（锁定技）
 *     · damageAsLoss()=true：Game.damage() 在扣血前询问来源，命中后不走
 *       藤甲 / 白银狮子修正，不触发 onDamaged（矢北等「受到伤害后」），
 *       也不做属性伤害的铁索传导；但伤害音效 / 受击特效 / 濒死阵亡照常。
 *   伤逝（自动 / 顶栏可改为询问）
 *     · onHandBelowX() 钩子：X = 已损失体力值（最高等于体力上限），
 *       手牌 < X 时补摸到 X 张。
 *       ★ 体力降到 0 / 负数、进入濒死之前也会复查一次（X 取到体力上限），
 *         摸到的【桃】可以赶在濒死自救时到手；实际体力仍保持负数。
 *       手牌离手（removeCard 收口，Game 排队后结算）与体力流失使 X 变大
 *       （damage / 矢北）都会复查同一条件，与事件类型无关。
 *       ★ 顶栏取消勾选「伤逝自动摸牌」后改为询问是否发动：伤害 / 矢北这类
 *         「扣血后、进濒死前」的直接复查在体力 0 / 负数时也照常询问，
 *         问完才继续进入濒死；只有濒死自救过程中（手牌离手的延后复查）
 *         不询问、直接按发动处理，避免和自救面板抢同一个 pending。
 *   翦灭（出牌阶段限一次，主动技按钮）
 *     · actions[0]（once:false）+ usable 检查 player.jianmieUsed。
 *       选一名其他角色 → 双方各选一种颜色（AI 按自己手牌颜色数量独立选，
 *       不偷看对手）→ 各自弃掉该颜色全部手牌 → 弃牌多的一方视为对另一方
 *       使用一张【决斗】（Tricks.use + opts.chosenTargets，不重复选目标）。
 *
 * 立绘按规则应为 assets/characters/WEI-ZhangChunHua.webp；素材缺失时
 * UI 现有的 probeArt() 会自动回退到 CSS 绘制，不影响规则与交互。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Characters = SGS.Characters || (SGS.Characters = {});

  const RED = '\u2665\u2666';

  /** 牌的颜色：优先读 color 字段，缺失时按花色兜底 */
  function colorOf(card) {
    if (!card) return 'black';
    if (card.color === 'red' || card.color === 'black') return card.color;
    return RED.indexOf(card.suit) >= 0 ? 'red' : 'black';
  }

  /** 某颜色手牌张数 */
  function countColor(player, color) {
    return ((player && player.hand) || []).filter((c) => colorOf(c) === color).length;
  }

  /** 无界面 / AI 的颜色选择：按自己手牌独立决定，不参考对手 */
  function autoColor(player) {
    return countColor(player, 'red') >= countColor(player, 'black') ? 'red' : 'black';
  }

  const COLOR_CHOICES = [
    { label: '红色', value: 'red' },
    { label: '黑色', value: 'black' }
  ];
  const colorName = (c) => (c === 'red' ? '红' : '黑');

  /** 一起弃掉某人手里指定颜色的全部手牌 */
  async function discardColor(game, player, color) {
    const cards = ((player && player.hand) || []).filter((c) => colorOf(c) === color);
    for (const c of cards) {
      await game.presentCard(c, player, { dest: 'showcase', note: '翦灭弃置' });
    }
    for (const c of cards) {
      const removed = (typeof player.removeCard === 'function')
        ? player.removeCard(c.id) : null;
      if (removed && game.deck && typeof game.deck.discard === 'function') {
        game.deck.discard(removed);
      }
    }
    if (game.ui && typeof game.ui.render === 'function') game.ui.render(game);
    return cards.length;
  }

  const data = {
    id: 'zhangchunhua',
    name: '张春华',
    displayName: '张春华',
    introName: '张春华',
    title: '冷血皇后',
    faction: '魏',
    image: 'ZhangChunHua.webp',   // → WEI-ZhangChunHua.webp
    maxHp: 3,
    avatar: '张',
    gender: 'female'
  };

  const skill = {
    name: '绝情',
    titles: '绝情 · 伤逝 · 翦灭',
    desc: '绝情（锁定技）：你即将造成的伤害视为失去体力。｜' +
          '伤逝：当你的手牌数小于X后，你可以将手牌摸至X张（X为你已损失体力值）。｜' +
          '翦灭：出牌阶段限一次，你可与一名其他角色同时选择一种颜色，你与其弃置各自选择颜色的手牌，然后弃置牌较多的角色视为对另一名角色使用一张【决斗】。',
    active: true,

    /** 【绝情】：伤害来源钩子，Game.damage() 扣血前读取 */
    damageAsLoss() { return true; },

    /**
     * 【伤逝】：手牌数小于 X（X = 已损失体力值）后自动摸至 X 张，不询问。
     * 触发条件与体力无关：手牌离手（Game.queueHandBelowX ← Player.removeCard）
     * 或体力流失使 X 变大（Game.checkHandBelowX ← damage / 矢北）都会复查同一条件。
     * Player.hook() 会把自己作为第一个参数传进来。
     *
     * ★ 这里只做「判断 + 摸牌」，不负责刷新界面：drawCards() 自己会渲染，
     *   落地后再补一次 render 反而是「立刻执行」时代留下的多余动作
     *   （飞牌期间那次重绘会让落点位置冒出真牌）。动画与普通摸牌完全同款。
     */
    async onHandBelowX(player, game, opts) {
      // ★ X = 已损失体力值 = 体力上限 - 当前体力，但**最大不超过体力上限**：
      //   体力被打到 0 或负数时按 0 计（1 体力吃【酒】+【杀】2 点 → -1，
      //   X 仍是 3 而不是 4）。实际体力照旧是负数，脱离濒死仍要回复到 1。
      const maxHp = player.maxHp || 3;
      const X = Math.max(0, maxHp - Math.max(0, player.hp));
      if (!X || ((player.hand || []).length >= X)) return;
      if (typeof game.drawCards !== 'function') return;
      // ★ 取消顶栏「伤逝自动摸牌」后，改为询问是否发动。
      //   · 伤害 / 矢北的调用是 direct（体力已扣、还没进濒死），此时 hp<=0
      //     也照常询问 —— 问完才继续往下走 brink()，不会和自救面板抢。
      //   · queueHandBelowX 的延后复查是 deferred：它可能正好落在濒死自救
      //     循环里（用桃后手牌离手），那时不弹询问、直接按发动处理。
      //   · 已有别的面板在等输入时也不问（避免互相覆盖）。
      const deferred = !!(opts && opts.deferred);
      if (!SGS.skillAutoEnabled('伤逝') && SGS.isDecider(player)) {
        const uiBusy = !!(game.ui && game.ui.pending);
        if (!uiBusy && (!deferred || player.hp > 0)) {
          const ok = await game.askOptional(player, {
            name: '伤逝', context: 'shangshi',
            desc: '【伤逝】：你的手牌数小于 ' + X + '，是否将手牌摸至 ' + X + ' 张？',
            yes: '发动', no: '不发动'
          });
          if (!ok) {
            if (SGS.log) SGS.log(player.name + ' 放弃发动【伤逝】。', 'sys');
            return;
          }
        }
      }
      const need = X - (player.hand || []).length;
      await game.drawCards(player, need);
      if (SGS.log) {
        SGS.log(player.name + ' 发动【伤逝】，将手牌摸至 ' + X + ' 张。', 'sys');
      }
    },

    /** 【翦灭】：出牌阶段限一次，用 actions 通道走右下技能按钮 */
    actions: [
      {
        name: '翦灭',
        scenes: ['play'],
        once: false,   // 每回合限一次，状态在 player.jianmieUsed
        // ★ 语音 / 技能大字由 run() 在「选完目标」之后播一次（见下面的
        //   announceSkill）；点按钮时先不播 —— 否则取消选目标也会响，
        //   run() 里再播一次就变成两遍。
        announce: false,
        usable(player) {
          return !player.jianmieUsed;
        },
        aiChoice(game, player, scene) {
          if (!game || !player || !SGS.canUseSkillAction(player, '翦灭', scene)) return null;
          if (!(game.players || []).some((p) => p !== player && !p.isDead())) return null;
          return '翦灭';
        },
        async run(game, player) {
          const others = (game.players || []).filter((p) => p !== player && !p.isDead());
          if (!others.length) return false;
          const probe = {
            id: SGS.uid('virtual'), type: 'juedou', name: '决斗',
            suit: '', rank: '', color: null, category: 'trick'
          };
          const target = await game.selectTarget(player, probe, others);
          if (!target) return false;   // 取消选目标不消耗次数
          player.jianmieUsed = true;
          if (typeof game.announceSkill === 'function') {
            game.announceSkill(player, '翦灭');
          }

          // 「同时选择」：两人各自独立选，等双方都选完才公布并结算
          const desc = (who) => '【翦灭】：' + who + ' 与你同时选择一种颜色。';
          const mine = SGS.isDecider(player)
            ? await game.askChoice(player, {
                name: '翦灭', desc: desc('你'), choices: COLOR_CHOICES
              }) : autoColor(player);
          const theirs = SGS.isDecider(target)
            ? await game.askChoice(target, {
                name: '翦灭', desc: desc(player.name), choices: COLOR_CHOICES
              }) : autoColor(target);
          const myColor = mine === 'red' || mine === 'black' ? mine : autoColor(player);
          const theirColor = theirs === 'red' || theirs === 'black' ? theirs : autoColor(target);

          if (SGS.log) {
            // ★ 这里刻意不写「发动【翦灭】」：ui.log 的兜底会把这种句式当成
            //   技能发动再播一次横幅 / 语音。语音只在上面选完目标时播一次。
            SGS.log(player.name + ' 与 ' + target.name + ' 同时亮出颜色：' +
              player.name + ' 选【' + colorName(myColor) + '】、' + target.name +
              ' 选【' + colorName(theirColor) + '】。', 'sys');
          }
          const mineCount = await discardColor(game, player, myColor);
          const theirCount = await discardColor(game, target, theirColor);
          if (SGS.log) {
            SGS.log(player.name + ' 弃置 ' + mineCount + ' 张，' + target.name +
              ' 弃置 ' + theirCount + ' 张。', 'sys');
          }
          if (mineCount === theirCount) {
            if (SGS.log) SGS.log('双方弃置数量相同，【翦灭】不产生【决斗】。', 'sys');
            return true;
          }
          const attacker = mineCount > theirCount ? player : target;
          const defender = mineCount > theirCount ? target : player;
          const duel = {
            id: SGS.uid('virtual'), type: 'juedou', name: '决斗',
            suit: '', rank: '', color: null, category: 'trick'
          };
          if (SGS.log) {
            SGS.log('【翦灭】：弃牌较多的 ' + attacker.name +
              ' 视为对 ' + defender.name + ' 使用一张【决斗】。', 'sys');
          }
          if (SGS.Tricks && typeof SGS.Tricks.use === 'function') {
            await SGS.Tricks.use(game, attacker, duel, {
              realCard: duel, chosenTargets: [defender], skillName: '翦灭'
            });
          }
          return true;
        }
      }
    ],

    shaLimit(player, defaultLimit) { return defaultLimit; },
    asSha(player, card) { return SGS.Cards.isSha(card.type); },
    asShan(player, card) { return card.type === 'shan'; }
  };

  Characters.zhangchunhua = Object.assign({}, data, { skill: skill });
})(typeof window !== 'undefined' ? window : globalThis);
