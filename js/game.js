/**
 * game.js
 * 游戏主循环：一个回合严格走完六个阶段，回合结束后切换给对手。
 *
 *   准备 → 判定 → 摸牌 → 出牌 → 弃牌 → 结束
 *
 * 规则结算（杀 / 闪 / 桃 / 酒、伤害、濒死、胜负、通用响应）也集中在这里；
 * 七种锦囊的效果在 tricks.js，本文件只负责转交与公共结算流程。
 * 玩家交互通过 ui.js 提供的 Promise 挂起，AI 决策由 ai.js 驱动，
 * 因此主循环本身是清晰、线性的 async 流程。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  class Game {
    /**
     * @param {SGS.UI} ui 界面对象
     * @param {string} humanCharId 玩家选择的角色 id，另一个角色自动分配给 AI
     * @param {object} [opts] { mode, rng }
     *   mode：座次规则的模式 id。'1v1' → 按场上人数随机分配 1..N 序号；
     *         未登记 / 不传 → 保持给定顺序（自测与联机客机由主机指定座次）。
     *   rng ：可注入随机源，联机时主机把同一 seed 发给两端，座次与牌序一致。
     *   remoteCharId / remote：联机时第二个座位由远端玩家执掌，角色由
     *         客机选定后下发；isRemote=true 让它走「远程 UI」而不是 AI。
     *   uiRouter：联机时挂一个路由器，把所有 waitXXX 按决策者自动分发到
     *         本地 UI 或远程 UI；其余展示方法原样转给本地 UI。规则层因此
     *         完全不知道有网络，单机路径一行不变。
     */
    constructor(ui, humanCharId, opts) {
      opts = opts || {};
      this.localUI = ui;                       // 真实界面（主机自己看的）
      this.ui = opts.uiRouter || ui;           // 决策入口（联机时被路由）
      this.mode = opts.mode || null;
      this.deck = new SGS.Deck();

      const chars = SGS.Characters;
      const humanChar = chars[humanCharId] || chars.zhangfei;
      // ★ 1v1 模式：AI 从「除玩家已选之外」的全部武将里随机挑一个；
      //   未指定 mode 的自测入口保持原来的确定性（首个不同角色），
      //   联机则由主机下发 remoteCharId，绝不本地随机覆盖。
      const others = Object.keys(chars).map((k) => chars[k])
        .filter((c) => c && c.id !== humanChar.id);
      const teamMode = this.mode === '2v2';
      this.teamMode = teamMode;
      let aiChar = (opts.remoteCharId && chars[opts.remoteCharId]) || null;
      if (!aiChar && this.mode === '1v1' && others.length) {
        const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
        const idx = Math.max(0, Math.min(others.length - 1,
          Math.floor(rng() * others.length)));
        aiChar = others[idx];
      }
      aiChar = aiChar || others[0] || chars.zhaoyun;

      // ★★ 2v2 联机：房主已经排好「四个人 + 各自武将 + 固定座位」，
      //   通过 opts.roster 直接建人，不再随机座次 / 随机武将：
      //   roster = [{ charId, seat, isHuman, isRemote, nickname }, …]
      //   这样房主与三台客机看到的座位、阵营、昵称完全一致。
      if (Array.isArray(opts.roster) && opts.roster.length) {
        this.players = opts.roster.map((r) => {
          const c = chars[r.charId] || humanChar;
          const p = new SGS.Player(c, !!r.isHuman);
          p.seat = r.seat;
          p.nickname = r.nickname || '';
          p.isRemote = !p.isHuman && !!r.isRemote;
          if (teamMode) p.team = SGS.teamOfSeat(p.seat);
          return p;
        }).sort((a, b) => a.seat - b.seat);
        this.human = this.players.find((p) => p.isHuman) || this.players[0];
        this.aiPlayer = this.players.find((p) => !p.isHuman) || this.players[1];
      } else {
      this.human = new SGS.Player(humanChar, true);
      let roster;
      if (teamMode) {
        // ★ 2v2：一共四人。AI 从「玩家已选之外」的将池里随机取三个
        //   互不相同的角色；联机时由主机按座位下发 aiCharIds（其余位置是
        //   真人，仍然由主机统一决定武将，保证两端一致）。
        const preset = Array.isArray(opts.remoteCharIds) ? opts.remoteCharIds : [];
        const pool = SGS.shuffleWith(others.slice(),
          typeof opts.rng === 'function' ? opts.rng : Math.random);
        const picks = [];
        for (let i = 0; i < 3; i++) {
          const want = preset[i] && chars[preset[i]];
          const c = want || pool.find((x) => picks.indexOf(x) < 0);
          if (c) picks.push(c);
        }
        roster = [this.human].concat(picks.map((c) => new SGS.Player(c, false)));
        this.aiPlayer = roster[1];
      } else {
        this.aiPlayer = new SGS.Player(aiChar, false);
        roster = [this.human, this.aiPlayer];
      }
      if (opts.remote) this.aiPlayer.isRemote = true;
      // players 数组即逆时针行动顺序，按座位号升序：一号位在下标 0。
      // ★ 座次由模式规则分派：1v1 把 1..N 序号随机分配给场上角色，
      //   所以先手可能是玩家也可能是 AI；human / aiPlayer 引用始终不变，
      //   UI 仍按下=玩家、上=AI 布局，只是两者的座位号会互换。
      //   未登记模式（含不传 opts 的自测入口）保持原顺序，结果完全确定。
      this.players = roster;
      if (typeof SGS.assignSeats === 'function') {
        this.players = SGS.assignSeats(this.players, this.mode, opts.rng);
      }
      this.players.forEach((p, i) => {
        if (!p.seat) p.seat = i + 1;
        // ★ 2v2 阵营跟着座位号走（1/4 = A，2/3 = B）；其它模式不设置，
        //   identityOf() 会退回「主 / 敌」。
        if (teamMode) p.team = SGS.teamOfSeat(p.seat);
      });
      }
      // ★【伤逝】桥接：Player.removeCard() 移走手牌后回到这里复查
      //   「手牌数 < X」；同时保留失血时的复查（X 变大也会让条件成立）。
      //   ★ 这里只【排队】，不在当前同步栈里立刻摸牌 —— 见 queueHandBelowX。
      this._handBelowXPending = [];
      this._handBelowXFlush = null;
      SGS.onHandRemoved = (player) => this.queueHandBelowX(player);
      this.ai = new SGS.AI(this);

      this.current = 0;   // 0 = 一号位（先手），不再恒为玩家
      this.round = 1;
      this.phase = null;
      this.over = false;

      this.dealStartHands();
    }

    get actor() {
      return this.players[this.current];
    }

    /**
     * ★ 这个座位的决策要不要「问人」：本地真人走本地 UI，远端玩家走
     *   路由器转发的远程 UI，两者都挂起 Promise；只有纯 AI 才走 ai.askXXX。
     *   单机时 isRemote 恒为 undefined，结果与原来逐字一致。
     */
    isDecider(player) {
      return SGS.isDecider(player);
    }

    foeOf(player) {
      return player === this.human ? this.aiPlayer : this.human;
    }

    /** 两名角色是否同阵营（2v2）；非组队模式恒为 false（自己除外） */
    isTeammate(a, b) {
      if (!a || !b) return false;
      if (a === b) return true;
      return !!(this.teamMode && a.team && b.team && a.team === b.team);
    }

    /** 同阵营的其它角色（2v2）；非组队模式返回空数组 */
    teammatesOf(player, aliveOnly) {
      if (!this.teamMode || !player || !player.team) return [];
      return (this.players || []).filter((p) => p && p !== player &&
        p.team === player.team && (!aliveOnly || !p.dead));
    }
    /** 该阵营是否还有存活角色 */
    teamAlive(team) {
      return (this.players || []).some((p) => p && p.team === team && !p.dead);
    }
    /**
     * ★ 2v2 胜负：任一方的两名角色全部阵亡 → 另一方获胜。
     *   返回获胜阵营（'A' / 'B'），还没有阵营全灭时返回 null。
     */
    wipedTeam() {
      if (!this.teamMode) return null;
      const teams = ['A', 'B'];
      const alive = teams.filter((t) => this.teamAlive(t));
      return alive.length === 1 ? alive[0] : (alive.length === 0 ? 'none' : null);
    }

    /**
     * ★ 技能发动动画的统一入口。
     * 绝大多数技能由 ui.log() 从「XX 发动【技能】」日志兜底自动播横幅；
     * 少数没有这类日志的锁定技（看破 / 藏拙等）在这里显式播一次。
     * 假 UI（headless 自测）没有这个方法时静默跳过，不影响规则结算。
     */
    announceSkill(player, name) {
      if (this.ui && typeof this.ui.skillFX === 'function') {
        this.ui.skillFX(player, name);
      }
    }

    /**
     * 两名角色的距离（三国杀标准判定）。
     * 基础值取座位圈两个方向中较短的一侧：SGS.seatDistance(n, i, j)。
     * 其上叠加坐骑修正：
     *   【绝影】(+1 马) 装备在**目标**身上 → 别人算到他的距离 +1；
     *   【赤兔】(-1 马) 装备在**使用者**身上 → 他算到别人的距离 -1。
     * 既读角色上的 distanceBonus / distanceReduce 字段（早期预留接口，普通对象
     * 测试桩可直接赋值），也读 equipment.js 的真实装备，二者可叠加。
     * 不同角色之间距离最小为 1。
     */
    distance(from, to) {
      if (from === to) return 0;
      // ★ 阵亡角色不再占用座位：距离只在「存活角色围成的圈」上计算，
      //   因此阵亡者两侧的两人自动相邻（距离 1）。座位号本身不变 ——
      //   回合顺序、身份显示仍按原座次。
      const alive = (this.players || []).filter((p) => p && !p.dead);
      let i = alive.indexOf(from);
      let j = alive.indexOf(to);
      let d;
      if (i >= 0 && j >= 0) {
        d = SGS.seatDistance(alive.length, i, j);
      } else {
        // 兜底（阵亡者自己参与的距离查询，理论上不会出现）：用原座圈
        const n = this.players.length;
        i = this.players.indexOf(from);
        j = this.players.indexOf(to);
        d = SGS.seatDistance(n, i, j);
      }
      const bonus = (to.distanceBonus || 0) +
        (SGS.Equipment ? SGS.Equipment.distanceBonus(to) : 0);
      const reduce = (from.distanceReduce || 0) +
        (SGS.Equipment ? SGS.Equipment.distanceReduce(from) : 0);
      d += bonus - reduce;
      return Math.max(1, d);
    }

    /**
     * 列出这张牌当前所有合法目标（按 players 的逆时针顺序）。
     * 依据 cards.js 的 target 元数据：
     *   self        → [使用者]
     *   all         → 全场所有存活角色（含自己，如桃园结义）
     *   all-others  → 所有其他存活角色（万箭齐发 / 南蛮入侵）
     *   other       → 按 maxDistance / needCards / needWeapon 筛出的其他角色（需显式点一名）；
     *                 needCards 判定的是「任意区域有牌」（手牌 / 装备区 / 判定区）
     *   any         → 可含使用者本人，按 needHand 筛（火攻）
     *   borrow      → 其他 + 装备区有武器（借刀杀人）
     *   chain       → 所有存活角色，含自己（铁索连环，选 1~2 名）
     *
     * asType：这张牌「实际当作」什么牌来用。龙胆把【闪】当【杀】时，
     * 目标规则必须按【杀】（other / 距离 1）而不是牌面【闪】（self）来算，
     * 否则合法目标会错成使用者自己、对手卡点不动。普通牌不传即按牌面判定。
     */
    listTargets(user, card, asType) {
      const type = asType || card.type;
      const t = SGS.Cards.targetOf(type);
      if (t.mode === 'self') {
        // ★【闪电】同一角色判定区只能有一张；自己已有闪电时不能使用
        if (type === 'shandian' && (user.delayed || []).some((c) => c.type === 'shandian')) return [];
        return [user];
      }
      if (t.mode === 'all') return this.players.filter((p) => !p.isDead());
      if (t.mode === 'all-others') return this.players.filter((p) => p !== user && !p.isDead());
      let maxD = t.maxDistance === undefined ? Infinity : t.maxDistance;
      // ★【杀】的合法距离 = 使用者当前的**武器攻击范围**（无武器默认 1），
      //   而不是牌面写死的 1。诸葛连弩范围仍是 1；将来加入范围 2/3 的武器时，
      //   这里会自动放宽。顺手牵羊的「距离 1」不受武器影响。
      if (SGS.Cards.isSha(asType || card.type)) {
        maxD = SGS.Equipment ? SGS.Equipment.attackRange(user) : 1;
      }
      // ★ 同一角色判定区不能同时有两张同类延时锦囊：从目标列表源头排除
      const delayedDup = (type === 'lebusishu' || type === 'bingliangcunduan' ||
        type === 'shandian');
      const ok = (p) =>
        !p.isDead() &&
        (!delayedDup || !(p.delayed || []).some((c) => c.type === type)) &&
        (!t.needCards || SGS.Zones.hasAny(p)) &&
        (!t.needHand || (p.hand && p.hand.length > 0)) &&
        (!t.needWeapon || !!(p.equips && p.equips.weapon)) &&
        this.distance(user, p) <= maxD;
      // ★【火攻】的「任意角色」包括使用者自己（mode 'any'）。
      if (t.mode === 'any') return this.players.filter(ok);
      // ★【铁索连环】可选 1~2 名任意存活角色（含自己），这里先列出全部候选，
      //   具体选几名由 selectTargets 的 chain 分支负责。
      if (t.mode === 'chain') return this.players.filter((p) => !p.isDead());
      return this.players.filter((p) => p !== user && ok(p));
    }

    /**
     * 选中一名目标（即使 1v1 也必须显式点一次，不自动指定）。
     * 玩家侧挂起在 ui.waitTarget（点高亮的角色卡），AI 侧自动取首个合法目标。
     * 选定后发起黄色直线动画：从选择方向目标方画出，再自选择方开始渐消失；
     * 动画自行播放不阻塞后续结算，因此可与【顺手牵羊】面板叠加显示。
     * @returns {Promise<object|null>} null = 玩家取消（牌不消耗）
     */
    async selectTarget(user, card, targets) {
      if (!targets || !targets.length) return null;
      let target;
      if (SGS.isDecider(user)) {
        target = await this.ui.waitTarget(user, card, targets, this);
      } else {
        // AI 对「可选自己也可选别人」的牌（火攻）优先打对手；
        // ★ 2v2：绝不指向队友 —— 先在非队友里挑，都不可选时才退回原列表；
        //   同阵营优先打残血的那个（更像人）。
        const others = targets.filter((p) => p !== user);
        let pool = others.length ? others : targets;
        if (this.teamMode) {
          const foes = pool.filter((p) => !this.isTeammate(user, p));
          if (foes.length) pool = foes;
          else if (this.ai && typeof this.ai.harmfulTrick === 'function' &&
                   this.ai.harmfulTrick(card)) {
            // ★ 2v2：有害单体锦囊（火攻 / 决斗 / 顺手 / 过河…）没有任何
            //   敌方合法目标时宁可不用，也绝不回头打队友。
            //   旧版这里会退回 others（含队友），于是「敌方阵亡一人后
            //   诸葛亮用火攻烧队友」「敌人没手牌时火攻打自己人」。
            return null;
          }
        }
        pool = pool.slice().sort((a, b) =>
          (a.hp || 0) - (b.hp || 0) || (b.maxHp || 0) - (a.maxHp || 0));
        target = pool[0] || targets[0];
        await SGS.sleep(60);
      }
      if (!target) return null;
      // ★【火攻】自己为目标时不拉黄线
      if (target !== user && this.ui.showTargetLine) this.ui.showTargetLine(user, target);
      await SGS.sleep(user.isHuman ? 300 : 100); // 让「发起」段先画出来
      return target;
    }

    /**
     * 解析一张牌的全部目标（可能一对多），统一供锦囊使用。
     *  - self                 → [使用者]，不选目标、不画线
     *  - all / all-others     → 自动对全体合法目标生效，不弹选择；
     *                           从使用者向**每个**其他目标各拉一条黄线（一对多）
     *  - other                → 沿用 selectTarget 显式点一名，画一条黄线
     *  - any                  → 显式点一名（可为自己），自己为目标时不画线
     *  - borrow               → 一次点两名：借刀目标 + 攻击范围内另一名；
     *                           先画使用者→目标，再画目标→另一名
     *  - chain                → 一次点 1~2 名（可含自己），向每名目标各画一条线
     * @returns {Promise<Array>} 目标数组；空数组 = 玩家取消 / 无合法目标（牌不消耗）
     */
    async selectTargets(user, card, targets) {
      const mode = SGS.Cards.targetOf(card.type).mode;
      if (mode === 'self') return targets && targets.length ? targets : [user];
      if (mode === 'borrow') {
        let picks = null;
        if (SGS.isDecider(user)) {
          if (this.ui && typeof this.ui.waitTargets === 'function') {
            picks = await this.ui.waitTargets(user, card, targets, this, 2);
          }
        } else if (targets.length) {
          // ★ 2v2：优先借敌人的刀；【杀】目标优先挑「被借刀者的队友」
          //   （让他们内耗），其次任何不是自己的角色，最后才轮到自己。
          let first = targets[0];
          if (this.teamMode) {
            const foe = targets.find((p) => !this.isTeammate(user, p));
            if (foe) first = foe;
          }
          const seconds = this.listTargets(first, { type: 'sha' }, 'sha');
          let second;
          if (this.teamMode) {
            second = seconds.find((p) => p !== user && this.isTeammate(first, p)) ||
              seconds.find((p) => p !== user) || seconds.find((p) => p === user);
          } else {
            second = seconds.find((p) => p === user) || seconds[0];
          }
          if (second) picks = [first, second];
        }
        if (!picks || picks.length < 2) return [];
        const [target, other] = picks;
        if (this.ui && typeof this.ui.showTargetLine === 'function') {
          if (target !== user) {
            this.ui.showTargetLine(user, target);
            await SGS.sleep(user.isHuman ? 300 : 100);
          }
          // ★ 第二条走平行轨道，避免 1v1 下与第一条完全重叠而看不见
          this.ui.showTargetLine(target, other, { lane: 1 });
          await SGS.sleep(user.isHuman ? 300 : 100);
        }
        return [target, other];
      }
      if (mode === 'chain') {
        // ★【铁索连环】：玩家一次点 1~2 名（含自己），点击顺序即目标顺序；
        //   AI 默认连对手，多人局会把自己也连上以放大属性伤害传导。
        const t = SGS.Cards.targetOf(card.type);
        const min = t.minTargets || 1;
        // ★【连环】：使用【铁索连环】可多指定一名角色（2 → 3）；
        //   hook 默认 0，普通角色行为完全不变。
        const bonus = (user && typeof user.hook === 'function')
          ? (user.hook('chainTargetBonus') || 0) : 0;
        const max = (t.maxTargets || 2) + bonus;
        let picks = null;
        if (SGS.isDecider(user)) {
          if (this.ui && typeof this.ui.waitChainTargets === 'function') {
            picks = await this.ui.waitChainTargets(user, card, targets, this, min, max);
          }
        } else if (targets.length) {
          if (this.teamMode) {
            // ★ 2v2：只连敌人，绝不自连 / 连队友（属性伤害会溅到自己人）；
            //   ★ 已处于连环状态的敌人不再重复指定 —— 再连一次没有任何收益，
            //     只会浪费一张【铁索连环】和一次多目标名额。
            const foes = targets.filter(
              (p) => !this.isTeammate(user, p) && !p.chained);
            picks = foes.slice(0, max);
          } else {
            // ★ 1v1：敌方已经连环时同样不再浪费这张牌（返回 [] 让牌不消耗）
            const foe = targets.find((p) => p !== user && !p.chained);
            picks = foe ? [user, foe] : [];
          }
        }
        if (!picks || picks.length < min) return [];
        picks = picks.slice(0, max);
        // ★【连环】：真·铁索连环（非♣转化）多连一人时补一条发动记录，
        //   UI.log 会统一兜底播技能大字 + SHU-PangTong_LianHuan.webm
        if (bonus > 0 && picks.length > (t.maxTargets || 2) &&
            !card.viaSkill && SGS.log) {
          const skName = (user.skill && user.skill.chainTargetSkill) || '连环';
          SGS.log(user.name + ' 发动【' + skName +
            '】，使用【铁索连环】额外指定一名角色为目标。', 'sys');
        }
        // 向每名目标（除自己）拉一条黄线，表示铁索连到这些人
        if (this.ui && typeof this.ui.showTargetLines === 'function') {
          this.ui.showTargetLines(user, picks);
        }
        await SGS.sleep(user.isHuman ? 260 : 100);
        return picks;
      }
      if (mode === 'all' || mode === 'all-others') {
        if (!targets || !targets.length) return [];
        // ★ 一对多：向每个其他目标各画一条黄线（1v1 只有一条，多人局自动散开）
        if (this.ui && typeof this.ui.showTargetLines === 'function') {
          this.ui.showTargetLines(user, targets);
        } else if (this.ui && typeof this.ui.showTargetLine === 'function') {
          targets.forEach((p) => { if (p !== user) this.ui.showTargetLine(user, p); });
        }
        await SGS.sleep(user.isHuman ? 260 : 100); // 让「发起」段先画出来
        return targets;
      }
      const t = await this.selectTarget(user, card, targets);
      return t ? [t] : [];
    }

    /**
     * 统一的「卡牌出场」入口：让 ui.js 把这张牌从来源平滑移动到目的地，
     * 动画结束后落到展示区（或手牌区）。无动画能力（自测假界面）时直接落地，
     * 保证规则结算不受影响。
     *
     * opts：
     *   from      'hero' 强制从角色框出发（被拆 / 被牵的牌）；
     *             'equip' 从对应装备槽出发（被同槽替换下来的旧装备）
     *   dest      'showcase'（默认）| 'hand' | 'ai-hero' | 'equip'
     *   slot      dest==='equip'（或 from==='equip'）时的装备槽 key（weapon / armor / horsePlus / horseMinus）
     *   toPlayer  dest==='equip' 时装备落到谁身上
     *   faceDown  true = 移动过程中背面朝上（仅 AI 获得牌 / 其它背面场景；
     *             dest==='hand' 即玩家获得牌时一律正面，不受此值影响）
     *   asName    当作某牌时展示的小标签（「当作【闪】」）
     *   note      展示区同一位置的自定义说明（「替换弃置」等）
     *   onArrive  到达后的自定义回调（用于「收进手牌 / 装上装备」这类状态变更）
     */
    /**
     * ★ 角色「使用」或「打出」一张实体牌时的牌语音统一入口。
     * 刻意不放在 presentCard() 里：那个方法还负责判定亮牌、五谷亮牌、
     * 被拆/被牵、弃牌、装备替换、火攻展示等「牌出场但不是使用/打出」的
     * 场合，会误播。只在下面几个语义明确的时点调用：
     *   · applyPlay   出牌阶段的桃 / 酒 / 装备 / 基本牌转化
     *   · useSha / Tricks.use  目标确定之后再播（杀 / 锦囊，取消选目标不播）
     *   · askRespond  打出【闪】/【杀】响应（含 AOE、决斗）
     *   · askWuXie    使用或转化使用【无懈可击】
     *   · brink       濒死用【桃】/【酒】自救
     *   · 转化技      渐营当基本牌 / 丈八蛇矛两张牌当【杀】
     * Audio 层再用 card.id + url 短时去重，保证同一次使用只播一次。
     * 八卦阵判定这类「虚拟响应」没有实体牌，不播。
     */
    playCardVoice(player, card, asType) {
      if (!player || (!card && !asType)) return;
      const type = asType || (card && card.type) || null;
      if (!type) return;
      try {
        if (SGS.Audio && typeof SGS.Audio.playCard === 'function') {
          SGS.Audio.playCard(player, type, card);
        }
      } catch (e) { /* 音频失败不影响结算 */ }
    }

    /** 受到伤害的作用音效：按伤害属性 + 最终点数 + 来源（火攻 / 闪电）选文件 */
    playDamageSound(dmgType, amount, opts) {
      try {
        if (SGS.Audio && typeof SGS.Audio.playDamage === 'function') {
          SGS.Audio.playDamage(dmgType, amount, opts || {});
        }
      } catch (e) { /* 音频失败不影响结算 */ }
    }

    /**
     * ★ 回复体力的唯一入口：所有形式（桃 / 濒死酒自救 / 桃园结义 /
     *   白银狮子失去 / 矢北）都走这里，保证「加血」音效不漏、不重复。
     *   只在体力真正增加时播；满血 / 已到上限时不播，也不溢出。
     * @returns {number} 实际回复点数
     */
    healPlayer(player, amount) {
      if (!player) return 0;
      const before = player.hp;
      player.hp = Math.min(player.maxHp, player.hp + (amount || 1));
      const gained = player.hp - before;
      if (gained > 0) {
        try {
          if (SGS.Audio && typeof SGS.Audio.playHeal === 'function') SGS.Audio.playHeal();
        } catch (e) { /* 音频失败不影响结算 */ }
      }
      return gained;
    }

    async presentCard(card, fromPlayer, opts) {
      opts = opts || {};
      // ★ 若这张实体牌此刻装备在身上（技能把装备区的「牌」当素材使用/打出），
      //   飞牌起点自动改成对应装备槽，而不是错误地从手牌区出发。
      //   只在调用方没有显式指定 from 时补，过河拆桥 / 替换旧装备等不受影响。
      const zoneEntry = (fromPlayer && SGS.Zones && SGS.Zones.find)
        ? SGS.Zones.find(fromPlayer, card.id) : null;
      if (!opts.from && zoneEntry && zoneEntry.zone === 'equip') {
        opts = Object.assign({}, opts, {
          from: 'equip', slot: zoneEntry.zoneKey
        });
      }
      // ★ 全场公开的【获得牌】：装备区 / 判定区的牌本来就是明牌，谁都看得见，
      //   被牵走时飞牌一律正面 —— 藏成牌背反而是错的。
      //   唯一的来源是区域层的 faceUp（手牌 false、装备区/判定区 true）；
      //   调用方显式给了 public 就尊重调用方（五谷丰登亮出的牌走这条）。
      //   ★ 只对「进手牌」的飞牌生效：过河拆桥这类是【弃置】（dest 默认
      //     showcase，进弃牌堆），没有获得者，压根不是获得牌，不该带 public。
      const toHandFx = opts.dest === 'hand' || opts.dest === 'ai-hero';
      if (toHandFx && opts.public === undefined && zoneEntry && zoneEntry.faceUp) {
        opts = Object.assign({}, opts, { public: true });
      }
      if (this.ui && typeof this.ui.flyCard === 'function') {
        await this.ui.flyCard(card, fromPlayer, opts);
        return;
      }
      // 无 DOM 动画的界面：直接完成落地效果
      if (opts.onArrive) opts.onArrive();
      else if ((opts.dest || 'showcase') === 'showcase' &&
               this.ui && typeof this.ui.showTableCard === 'function') {
        this.ui.showTableCard(card, opts.asName, opts.note);
      }
    }

    /**
     * ★ 统一「实体牌离场」：把一张「牌」从原区域取走并进入弃牌堆。
     *
     * 技能描述里写「牌」= 手牌区 + 装备区四槽（不含判定区），
     * 【龙魂】/【渐营】/【火计】/【看破】等转化技可以把已装上的装备牌
     * 当素材使用或打出。Player.removeCard() 已能同时从两个区域取走，
     * 这里再统一：
     *   · 进弃牌堆（不管来源是手牌还是装备区）
     *   · 若来自装备区 → 结算「失去装备区里的牌」（【白银狮子】回血等）
     *   · 返回 SGS.Zones 条目（zone / zoneKey），供飞牌起点定位
     * 所有转化路径与普通出牌都改走这里，避免各处重复 removeCard + discard
     * 而漏掉装备区的「失去」结算。
     */
    async discardConsumed(player, card) {
      if (!player || !card) return null;
      const entry = (SGS.Zones && SGS.Zones.findConversionCard)
        ? SGS.Zones.findConversionCard(player, card.id) : null;
      if (!entry) return null;
      const removed = player.removeCard(card.id);
      const zone = player.lastRemovedZone ? player.lastRemovedZone() : null;
      if (player.clearRemovedZone) player.clearRemovedZone();
      const real = removed || card;
      this.deck.discard(real);
      if (zone && zone.zone === 'equip' &&
          typeof this.onEquipmentLost === 'function') {
        await this.onEquipmentLost(player, real);
      }
      return entry;
    }

    /**
     * ★ 一次性亮出 / 打出多张牌：玩家自己弃多张时所有飞牌同时起飞、
     *   同时落地，展示区也一次性让位，不再一张张串行蹦出来。
     * 无批量动画能力（假界面 / AI / 单张）自动退化成逐张 presentCard，
     * 规则结算与展示区标签条数完全不变。
     */
    async presentCards(cards, fromPlayer, opts) {
      cards = (cards || []).filter(Boolean);
      if (!cards.length) return;
      // ★ 来源可能混合：手牌 + 装备区（【三陈】这类「弃置三张牌」）。批量
      //   飞牌只支持同一来源，于是逐张走 presentCard —— 它会给装备区的牌
      //   自动补 from:'equip' + slot，从对应装备槽起飞而不是手牌区。
      const mixed = cards.some((c) => {
        if (!fromPlayer || !SGS.Zones || typeof SGS.Zones.find !== 'function') return false;
        const ze = SGS.Zones.find(fromPlayer, c.id);
        return !!(ze && ze.zone === 'equip');
      });
      if (!mixed && this.ui && typeof this.ui.flyCards === 'function') {
        await this.ui.flyCards(cards, fromPlayer, opts || {});
        return;
      }
      for (const c of cards) await this.presentCard(c, fromPlayer, opts);
    }

    /**
     * ★【伤逝】「手牌离手」复查的排队入口。
     *
     * 为什么不能在这里直接摸牌（曾经的做法，也是「立刻执行」特例的残留）：
     *   removeCard() 几乎总发生在别的流程中间 —— 出牌打出一张、翦灭弃色、
     *   过河拆桥拆牌…… 如果在同一同步栈里立刻 drawCards()，摸牌动画就会
     *   插进对方那套动画里；更要紧的是调用方在 removeCard 之后往往还有一次
     *   ui.render()，那次重绘会把「正在飞入手牌」的真牌节点重建成可见节点，
     *   于是飞牌期间落点位置就冒出一张真牌 —— 表现就是「伤逝的飞牌和普通
     *   角色不一样，落点位置还会渲染」。
     *   改成登记 + 微任务结算：等这一轮同步工作（含调用方随后的 render）
     *   全部走完，再按普通 drawCards 摸牌，动画与正常摸牌完全一致。
     *
     * 同一角色在一轮里可能被多次 removeCard，排队时去重，只在 flush 时
     * 复查一次（hook 内部仍会再判一次「手牌数 < X」，不会多摸）。
     */
    queueHandBelowX(player) {
      if (!player) return;
      const q = this._handBelowXPending || (this._handBelowXPending = []);
      if (q.indexOf(player) < 0) q.push(player);
      if (this._handBelowXFlush) return;
      this._handBelowXFlush = Promise.resolve()
        .then(() => this.flushHandBelowX())
        .catch((e) => {
          if (typeof console !== 'undefined' && console.warn) {
            try { console.warn('[game] 伤逝复查失败', e); } catch (e2) {}
          }
        })
        .then(() => {
          this._handBelowXFlush = null;
          // ★ 收尾竞态兜底：flush 判空返回 与 清空标志 之间若又有人入队，
          //   这里补排一次（queue 内部去重，hook 还会再判条件，不会多摸）。
          const rest = this._handBelowXPending;
          if (rest && rest.length) this.queueHandBelowX(rest[0]);
        });
    }

    /** 依次结算排队中的「手牌数 < X」复查 */
    async flushHandBelowX() {
      for (;;) {
        const q = this._handBelowXPending;
        if (!q || !q.length) return;
        const p = q.shift();
        // deferred：手牌离手后的延后复查。濒死自救期间（hp<=0）不在这里
        // 弹「是否发动」，否则会和自救面板抢同一个 pending。
        await this.checkHandBelowX(p, { deferred: true });
      }
    }

    /** 等排队中的复查全部结算完（收尾 / 自测用） */
    handBelowXSettled() {
      return this._handBelowXFlush || Promise.resolve();
    }

    /** 是否有排队中的「手牌数 < X」复查（可能正在弹【伤逝】询问） */
    handBelowXPending() {
      return !!(this._handBelowXFlush ||
        (this._handBelowXPending && this._handBelowXPending.length));
    }

    /**
     * ★【伤逝】统一检查入口：X = 已损失体力值（最高 = 体力上限），手牌数
     * 小于 X 后摸至 X 张。
     * 触发条件只看「手牌数 < X」，与是否失去体力无关；调用方有三处：
     *   · queueHandBelowX —— 任何手牌离手（Player.removeCard 统一收口，延后结算）
     *   · Game.damage / 矢北直接失血 —— X 因体力流失而变大（当场 await，
     *     摸到的【桃】要赶在濒死结算之前到手）
     *   · 体力降到 0 / 负数时同样复查（X 取到上限），在进入濒死之前补牌
     * 摸牌走常规 drawCards（含飞牌动画）；调用前已判条件，不会重复摸。
     */
    async checkHandBelowX(player, opts) {
      // ★ 只排除「已经阵亡结算完」的角色，不能用 isDead()（它等价于 hp<=0）：
      //   体力刚被打到 0 时正处于「濒死之前」的窗口，【伤逝】必须在这里
      //   触发（X 取到体力上限），摸到的【桃】才能用于自救。真正阵亡后
      //   onDeath 会打上 player.dead 标记，那时不再补牌。
      if (!player || player.dead) return;
      const hook = player.skill && player.skill.onHandBelowX;
      if (typeof hook !== 'function') return;
      // opts.deferred —— 由 queueHandBelowX 的延后 flush 传入：那一段可能
      // 正好落在濒死自救循环里，技能询问要避开（详见角色钩子里的判定）。
      await hook(player, this, opts || {});
    }

    /**
     * 摸牌并播放动画。
     *
     *  · 玩家自己摸牌：ui.flipInsertIntoHand() 先把牌插进手牌 —— 旧牌 FLIP
     *    平滑让位到新位置，新牌【正面朝上】从展示区飞进自己最终的格子。
     *    动画内部已完成 push + render（返回 handled=true），这里不重复入队。
     *  · AI 摸牌：手牌不可见，沿用「背面朝上叠放飞向 AI 角色框」，落地后入队。
     *  · 无 DOM 动画能力（自测假界面）：直接落地，规则结算完全不受影响。
     * 摸牌阶段（2 张）/ 无中生有（2 张）/ 重铸 / 雌雄双股剑等都走这里。
     */
    async drawCards(p, n) {
      const cards = this.deck.draw(n);
      if (!cards.length) return cards;
      let handled = false;
      if (this.ui && typeof this.ui.animateDraw === 'function') {
        // ★ 玩家自己摸牌的「插入手牌」动画内部已完成 push + render，
        //   返回 true 时这里不再重复入队；AI 摸牌 / 假界面返回 falsy → 直接落地。
        handled = await this.ui.animateDraw(cards, p, this);
      }
      if (!handled) {
        cards.forEach((c) => p.hand.push(c));
        this.ui.render(this);
      }
      return cards;
    }

    /**
     * ★ 记录「出牌阶段使用了一张牌」。所有使用入口（杀 / 桃 / 酒 / 装备 /
     *   锦囊 / 技能转化）最终都回调这里，因此渐营的「与上一张同花色或点数」
     *   与藏拙的「本回合是否用过锦囊」都只有一处判定。
     *
     *   opts.suit    当作牌的花色（【渐营】视为上一张牌的花色）
     *   opts.asType  当作的牌型（【火计】红色牌当【火攻】、【渐营】当基本牌）
     *
     * 只在「自己的出牌阶段」生效：响应、打出、弃置、濒死使用都不计入。
     * 回调角色 skill.onPlayCard(game, player, current, previous)；
     * 【渐营】在其中判断同花色/点数并摸牌（默认自动，顶栏可改为询问）。
     */
    async noteUsedCard(p, card, opts) {
      if (!p || !card || this.phase !== 'play' || this.actor !== p) return;
      opts = opts || {};
      const suit = opts.suit || card.suit || '';
      const rank = card.rank || '';
      const asType = opts.asType || card.type;
      if (!Array.isArray(p.playLog)) p.playLog = [];
      const previous = p.playLog.length ? p.playLog[p.playLog.length - 1] : null;
      const current = { card: card, suit: suit, rank: rank, asType: asType };
      p.playLog.push(current);
      // 【藏拙】：锦囊牌（含延时锦囊）使用后，本回合锦囊牌不再免计手牌上限
      if (SGS.Cards.isTrick(asType)) p.trickUsedThisTurn = true;
      const hook = p.skill && p.skill.onPlayCard;
      if (typeof hook === 'function') await hook(this, p, current, previous);
    }

    /** ★【火计】改写的火攻规则已移到 tricks.resolveHuogong()，
     *   旧的「观看牌堆顶 / 控顶排序 / 代替弃置」设计取消，两个钩子一并移除。
     */

    /**
     * 开局发牌。
     * 开局发生在选将界面背后、且构造函数不能 await，因此这里直接发牌、不播动画；
     * 之后所有「摸牌」（摸牌阶段 / 无中生有）一律走 drawCards() 的动画流程。
     * ★ 2v2：四号位起手 5 张（其余 4 张），用来弥补它是「最后行动」的劣势。
     */
    dealStartHands() {
      this.players.forEach((p) => {
        const n = (this.teamMode && p.seat === 4) ? 5 : 4;
        p.draw(this.deck, n);
        if (SGS.log) SGS.log(p.name + ' 获得 ' + n + ' 张起手牌。', 'sys');
      });
    }

    /** 对局总循环：直到分出胜负 */
    async run() {
      const h = this.human;
      const a = this.aiPlayer;
      if (SGS.log) {
        // ★ 座次随机后必须让玩家看清谁是一号位、为什么是对手先动。
        //   ★ 一律只写角色名：联机两端看到的是同一份记录，任何「你 / 对方 /
        //     AI」都会在另一半屏幕上变成错的（客机看到的「你」其实是主机）。
        if (this.mode && this.players.length) {
          const seats = this.players.map((p) =>
            SGS.seatLabel(p.seat) + '号位 ' + p.name).join('，');
          SGS.log('本局座次：' + seats + '；' + this.actor.name + ' 先手。', 'turn');
        }
        SGS.log(
          this.teamMode
            ? '对局开始：' + this.players.map((p) =>
                '【' + p.name + '·' + p.skill.name + '】').join(' VS ')
            : '对局开始：【' + h.name + '·' + h.skill.name + '】 VS 【' +
                a.name + '·' + a.skill.name + '】',
          'turn'
        );
        if (this.teamMode) {
          SGS.log('2v2 规则：一四号位同阵营、二三号位同阵营；一方两人全部阵亡即告负。' +
            '一号位首回合少摸一张，四号位起手五张，队友阵亡时同阵营另一人摸一张。', 'sys');
        }
        SGS.log('规则：每回合摸 2 张，杀限 1 次（咆哮除外），酒限 1 次，手牌上限 = 当前体力。', 'sys');
        SGS.log('锦囊：无中生有 / 过河拆桥 / 顺手牵羊 / 万箭齐发 / 南蛮入侵 / 桃园结义 / 决斗 / 火攻 / 借刀杀人 / 五谷丰登 / 铁索连环。', 'sys');
        SGS.log('延时锦囊：乐不思蜀（非红桃跳过出牌）/ 兵粮寸断（非梅花跳过摸牌）/ 闪电（黑桃2~9造成3点雷电伤害）。', 'sys');
        SGS.log('【无懈可击】可在锦囊生效前抵消其对一名角色的效果，也可抵消另一张【无懈可击】。', 'sys');
        SGS.log('装备：连弩 / 六种坐骑 / 仁王盾 / 藤甲 / 白银狮子 / 八卦阵 / 朱雀羽扇 / 青釭剑 / 丈八蛇矛 / 寒冰剑。', 'sys');
        SGS.log('新武器：青釭剑无视防具；丈八蛇矛点武器栏选两张手牌当杀；寒冰剑防止伤害改弃目标两张牌。', 'sys');
        SGS.log('属性杀：火杀（火焰伤害）/ 雷杀（雷电伤害）；【藤甲】怕火、挡普通杀与万箭齐发 / 南蛮入侵。', 'sys');
        SGS.log('新装备：【白银狮子】大伤害减至 1、失去后回 1 血；【八卦阵】判定红色当【闪】；【朱雀羽扇】普通杀改火杀。', 'sys');
        SGS.log('新锦囊：【五谷丰登】亮牌后依次选走；【铁索连环】横置 / 重置并在属性伤害时传导（角色框中间的锁链表示连环状态）。', 'sys');
      }
      this.ui.render(this);
      while (!this.over) {
        await this.runTurn();
      }
    }

    /** 单个回合：依次执行六个阶段 */
    async runTurn() {
      const p = this.actor;
      // ★ 阵亡角色不再行动：直接轮到下一名存活角色（2v2 里队友继续打，死者观战）。
      if (!p || p.dead) { await this.advanceTurn(); return; }
      p.resetTurn();
      // ★【矢北】「每回合第一次回血，此后每次失去体力」：每个回合开始时，
      //   所有角色的受伤计数都清零（不只行动方），对手回合里挨打也要计数。
      this.players.forEach((q) => { q.turnDamageCount = 0; q.shibeiHealed = false; });
      if (SGS.log) SGS.log('── 第 ' + this.round + ' 轮 · ' + p.name + ' 的回合 ──', 'turn');

      // ★ 翻面（背面朝上）：回合开始的瞬间先翻回正面，然后直接跳过整个回合
      //   —— 准备、判定、摸牌、出牌、弃牌、结束一个阶段都不进入。
      if (p.flipped) {
        p.flipped = false;
        if (SGS.log) {
          SGS.log(p.name + ' 的武将牌背面朝上：先翻回正面，然后跳过本回合。', 'sys');
        }
        this.ui.render(this);
        await SGS.sleep(760);
        await this.advanceTurn();
        return;
      }

      for (const ph of SGS.PHASES) {
        this.phase = ph.key;
        this.ui.setPhase(ph.key);
        this.ui.render(this);
        await this.runPhase(ph.key, p);
        if (this.over) return;          // 有人在阶段中阵亡，立即结束
        // ★ 2v2：行动方在本回合内阵亡（闪电 / 决斗反伤等），
        //   后续阶段不再执行 —— 死人不能继续摸牌出牌。
        if (p.dead) {
          if (SGS.log) SGS.log(p.name + ' 已阵亡，本回合剩余阶段跳过。', 'sys');
          break;
        }
        await SGS.sleep(280);
      }

      // ★ 角色回合真正结束：此时才清空展示区。这样弃牌阶段亮出的牌、
      //   替换弃置 / 被拆弃置的牌都能一直看到本角色回合结束。
      if (SGS.log) SGS.log(p.name + ' 回合结束，展示区清空。');
      if (this.ui && typeof this.ui.clearTableCard === 'function') this.ui.clearTableCard();

      await this.advanceTurn();
    }

    /** 回合切换：按座次交给下一名角色；回到一号位即进入下一轮。 */
    advanceTurn() {
      // 1v1 下等价于原来的 1-current，写成取模是为了将来多人局也成立。
      // ★ 阵亡角色不再拥有回合：一直前进到下一名存活角色为止；
      //   整圈都死光时（理论只在结算收尾瞬间出现）退回原下标，交给 over 收场。
      const n = this.players.length;
      let guard = 0;
      do {
        this.current = (this.current + 1) % n;
        if (this.current === 0) this.round++;
      } while (this.players[this.current] && this.players[this.current].dead &&
               ++guard < n);
      this.ui.render(this);
      return SGS.sleep(400);
    }

    /** 阶段分发 */
    async runPhase(key, p) {
      switch (key) {
        case 'prepare': return this.phasePrepare(p);
        case 'judge':   return this.phaseJudge(p);
        case 'draw':    return this.phaseDraw(p);
        case 'play':    return this.phasePlay(p);
        case 'discard': return this.phaseDiscard(p);
        case 'end':     return this.phaseEnd(p);
      }
    }

    // ① 准备阶段：重置回合内状态
    async phasePrepare(p) {
      p.shaUsed = 0;
      p.jiuUsed = false;
      p.jiuBuff = false;
      // 延时锦囊的跳过效果只作用于本回合，准备阶段先清掉上一次的标记
      p.skipDraw = false;
      p.skipPlay = false;
      if (SGS.log) SGS.log(p.name + '【准备阶段】重置【杀】/【酒】使用次数。');
      this.ui.render(this);
      // ★ 角色「准备阶段」钩子（觉醒技等）：与 onDamaged 同款——直接以
      //   (game, player) 调用角色自己的 skill 实现；没实现的角色完全无感。
      const hook = p.skill && p.skill.onPrepare;
      if (typeof hook === 'function') await hook(this, p);
    }

    /**
     * ② 判定阶段：逐张结算角色判定区里的延时锦囊牌。
     * 判定牌本身（从牌堆顶亮出的那张）由 SGS.Judge.run() 统一进弃牌堆；
     * 这里只负责把判定区的延时锦囊取下，并按判定结果执行效果 / 传给下家。
     */
    async phaseJudge(p) {
      // ★ 后置先判：后放进判定区的延时锦囊排在前头（LIFO）
      const pending = (p.delayed || []).slice().reverse();
      if (!pending.length) {
        if (SGS.log) SGS.log(p.name + '【判定阶段】判定区无牌，跳过。');
        return;
      }
      for (const card of pending) {
        if (this.over) return;
        const idx = (p.delayed || []).indexOf(card);
        if (idx < 0) continue;        // 可能已被过河拆桥 / 顺手牵羊取走

        // ★【无懈可击】：延时锦囊在「亮出判定牌之前」询问，按逆时针一圈
        const wxCtx = this.createWuXieCtx(card, card.delayedSource || p);
        const wuxied = await this.askWuXie(wxCtx, p, card.delayedSource || p);

        p.delayed.splice(idx, 1);
        this.ui.render(this);
        if (wuxied) {
          if (card.type === 'shandian') {
            // ★【闪电】被无懈：不进弃牌堆，和「没劈中」一样传给下一个
            //   判定区没有闪电的存活角色。
            if (SGS.log) SGS.log('【闪电】被【无懈可击】抵消，不进行判断。', 'trick');
            await this.passLightning(p, card, '被【无懈可击】抵消');
          } else {
            this.deck.discard(card);
            if (SGS.log) SGS.log('【' + card.name + '】被【无懈可击】抵消，不进行判断。', 'trick');
          }
          continue;
        }

        if (card.type === 'lebusishu') {
          const jr = await SGS.Judge.run(this, p, {
            reason: '乐不思蜀',
            isEffective: (c) => c.suit !== '\u2665'   // 非红桃 → 跳过出牌
          });
          if (jr && jr.effective) {
            p.skipPlay = true;
            if (SGS.log) SGS.log(p.name + ' 受【乐不思蜀】影响，将跳过出牌阶段。', 'warn');
          }
        } else if (card.type === 'bingliangcunduan') {
          const jr = await SGS.Judge.run(this, p, {
            reason: '兵粮寸断',
            isEffective: (c) => c.suit !== '\u2663'   // 非梅花 → 跳过摸牌
          });
          if (jr && jr.effective) {
            p.skipDraw = true;
            if (SGS.log) SGS.log(p.name + ' 受【兵粮寸断】影响，将跳过摸牌阶段。', 'warn');
          }
        } else if (card.type === 'shandian') {
          const jr = await SGS.Judge.run(this, p, {
            reason: '闪电',
            // 黑桃 2~9：牌堆构造的 rank 是字符串，兼容数字形式的测试牌
            isEffective: (c) => c.suit === '\u2660' && /^[2-9]$/.test(String(c.rank || ''))
          });
          if (!jr) {
            // 牌堆与弃牌堆都空、无法判定时，延时锦囊留在判定区下回合再判
            SGS.Zones.addDelayed(p, card);
            continue;
          }
          if (jr.effective) {
            // ★【闪电】为无来源伤害：不把置入者 / 当前角色当作伤害来源
            if (SGS.log) SGS.log(p.name + ' 被【闪电】劈中，受到 3 点雷电伤害。', 'thunder');
            // ★【闪电】固定走 09 号作用音效（优先于普通雷电属性规则）
            await this.damage(p, null, 3, 'thunder', { sound: 'shandian' });
          } else {
            await this.passLightning(p, card, '未命中');
          }
        } else {
          // 未知延时锦囊：不吞牌，直接进弃牌堆，避免卡在判定区
          this.deck.discard(card);
        }
        this.ui.render(this);
      }
    }

    /** 按 players 数组（逆时针座次）找 from 之后下一名存活角色 */
    nextAlive(from) {
      const n = this.players.length;
      if (n < 2) return null;
      const i = this.players.indexOf(from);
      if (i < 0) return null;
      for (let k = 1; k <= n; k++) {
        const p = this.players[(i + k) % n];
        if (p && p !== from && !p.isDead()) return p;
      }
      return null;
    }

    /**
     * 【闪电】传递：从当前角色起按逆时针找下一个「存活且判定区没有闪电」的角色。
     * 下一家已有闪电则跳过，继续往后找；找不到则进弃牌堆。
     */
    nextLightningTarget(from) {
      const n = this.players.length;
      const i = this.players.indexOf(from);
      if (n < 2 || i < 0) return null;
      for (let k = 1; k < n; k++) {
        const p = this.players[(i + k) % n];
        if (!p || p === from || p.isDead()) continue;
        if ((p.delayed || []).some((c) => c.type === 'shandian')) continue;
        return p;
      }
      return null;
    }

    /** 【闪电】未命中 / 被无懈后统一的传递结算 */
    async passLightning(from, card, reasonText) {
      const next = this.nextLightningTarget(from);
      if (next) {
        if (!card.delayedSource) card.delayedSource = from;
        SGS.Zones.addDelayed(next, card);
        if (SGS.log) {
          SGS.log('【闪电】' + (reasonText || '未命中') +
            '，跳过已有【闪电】的角色后，置入 ' + next.name + ' 的判定区。', 'warn');
        }
      } else {
        this.deck.discard(card);
        if (SGS.log) {
          SGS.log('【闪电】' + (reasonText || '未命中') +
            '，没有可传递的下家，牌进入弃牌堆。', 'warn');
        }
      }
      this.ui.render(this);
    }

    // ③ 摸牌阶段：摸 2 张（玩家正面插入手牌区 + 旧牌让位；AI 背面飞向角色框）
    async phaseDraw(p) {
      if (p.skipDraw) {
        p.skipDraw = false;
        if (SGS.log) SGS.log(p.name + '【摸牌阶段】被【兵粮寸断】跳过，不摸牌。', 'warn');
        return [];
      }
      // ★ 2v2：一号位的首个回合少摸一张（先手补偿）。
      //   只判「本轮 = 第 1 轮且座位 1」，之后的回合恢复正常的 2 张。
      const firstSeatShort = this.teamMode && p.seat === 1 && this.round === 1;
      const need = firstSeatShort ? 1 : 2;
      const cards = await this.drawCards(p, need);
      if (SGS.log) {
        SGS.log(p.name + '【摸牌阶段】摸了 ' + cards.length + ' 张牌' +
          (firstSeatShort ? '（一号位首回合少摸一张）' : '') + '。');
      }
      this.ui.render(this);
      return cards;
    }

    // ④ 出牌阶段：玩家手动 / AI 自动
    async phasePlay(p) {
      if (p.skipPlay) {
        p.skipPlay = false;
        if (SGS.log) SGS.log(p.name + '【出牌阶段】被【乐不思蜀】跳过。', 'warn');
        return;
      }
      if (SGS.log) SGS.log(p.name + '【出牌阶段】开始。');

      if (SGS.isDecider(p)) {
        // 玩家可反复出牌，直到主动结束出牌
        for (;;) {
          // ★ AI 托管：每轮决策前复查开关。勾上托管的那一刻，UI 会把正在
          //   等待的出牌操作 resolve 成 {type:'auto'}，这里立刻交给 AI 接管，
          //   不必等玩家先点一下「结束出牌」。
          if (SGS.Options && SGS.Options.autoTakeover &&
              p.isHuman && !p.isRemote) {
            if (SGS.log) SGS.log(p.name + '【AI 托管】由 AI 接管本回合出牌。', 'sys');
            await this.ai.playPhase(p);
            if (SGS.log) SGS.log(p.name + '【出牌阶段】结束。');
            return;
          }
          const act = await this.ui.waitPlay(p, this);
          if (act.type === 'auto') {          // 托管信号（见上）
            await this.ai.playPhase(p);
            if (SGS.log) SGS.log(p.name + '【出牌阶段】结束。');
            return;
          }
          if (act.type === 'end') {
            if (SGS.log) SGS.log(p.name + '【出牌阶段】结束。');
            return;
          }
          const ok = await this.applyPlay(p, act);
          if (this.over) return;
          // ★ 出牌途中阵亡（决斗反伤 / 火攻等）：立刻结束出牌阶段，
          //   绝不能让死人的界面继续等待下一次操作。
          if (p.dead) {
            if (SGS.log) SGS.log(p.name + ' 已阵亡，出牌阶段结束。', 'sys');
            return;
          }
          if (!ok) continue; // 使用不合法，继续等待下一次操作
          this.ui.render(this);
        }
      } else {
        // 托管中的本地真人也走这里（isDecider 已返回 false）：写一条说明，
        // 免得玩家以为「AI 托管」没生效、或者以为自己的操作被吞了。
        if (SGS.Options && SGS.Options.autoTakeover &&
            p.isHuman && !p.isRemote && SGS.log) {
          SGS.log(p.name + '【AI 托管】由 AI 接管本回合出牌。', 'sys');
        }
        await this.ai.playPhase(p);
        if (SGS.log) SGS.log(p.name + '【出牌阶段】结束。');
      }
    }

    /**
     * 处理玩家的一次出牌操作。
     * act = { type:'use', card, viaSkill?, conversion?, scene? }
     *   或 { type:'use', zhangba:true, cards:[两张手牌] }（丈八蛇矛主动转化）
     *
     * 「可以」类技能的转化牌必须带 viaSkill:true（只能由技能按钮产生），
     * 否则一律拒绝 —— 这样技能是玩家主动选择发动，而不是悄悄自动生效。
     * @returns {boolean} 是否成功使用（false 表示无效操作，需继续等待）
     */
    /**
     * 出牌阶段使用牌的统一入口。
     * ★ 牌语音一律在「确认合法、结算开始前」播：放到结算之后会被目标选择、
     *   锦囊响应链拖到几秒后，听感完全不对。重铸不视为使用；桃 / 装备牌
     *   没有素材，Audio 层自动静默。【杀】类统一由 useSha() 在目标确定后播
     *   （覆盖青龙偃月刀追加杀 / 丈八蛇矛 / 方天画戟），渐营 conv.to='basic'
     *   由 useConvertedBasic() 按选中的基本牌补播，Audio 层按 card.id 去重。
     */
    async applyPlay(p, act) {
      if (!act) return false;
      // ① 丈八蛇矛：两张手牌当【杀】使用（由装备区武器栏点击触发，
      //    不是技能按钮，因此单独走一条分支，不要求 act.card）
      if (act.zhangba) return await this.useZhangbaSha(p, act.cards);
      // ★ 一次性主动技（【涅槃】）：右下技能按钮回传 {type:'skillAction', name, scene}
      if (act.type === 'skillAction') {
        return await this.useSkillAction(p, act.name, act.scene || 'play');
      }
      if (!act.card) return false;
      const card = act.card;
      // ★「牌」= 手牌 + 装备区（不含判定区）：转化技能的素材可以来自装备栏。
      //   普通出牌仍由后面的牌面分支自然限制，这里只放宽素材来源校验。
      const inZones = (SGS.Zones && SGS.Zones.findConversionCard)
        ? SGS.Zones.findConversionCard(p, card.id) : null;
      if (!inZones) return false;

      // ★【铁索连环】重铸：弃置此牌摸一张，不进入锦囊使用流程。
      //   【连环】允许把 ♣ 牌当【铁索连环】重铸，走与转化使用同一套校验。
      if (act.type === 'reforge') {
        if (act.viaSkill) {
          const cv = act.conversion;
          if (!cv || cv.to !== 'tiesuolianhuan' || !cv.reforge ||
              (cv.scenes || ['play']).indexOf(act.scene || 'play') < 0 ||
              !SGS.Cards.matchesFrom(card, cv.from) ||
              !p.canUseAsType(card, cv.to)) {
            if (SGS.log) SGS.log('这张牌不能重铸。', 'warn');
            return false;
          }
        } else if (card.type !== 'tiesuolianhuan') {
          if (SGS.log) SGS.log('这张牌不能重铸。', 'warn');
          return false;
        }
        return await this.reforge(p, card, {
          // ★【连环】：♣ 牌当铁索连环重铸也要有触发记录 / 技能语音
          skillName: act.viaSkill
            ? ((act.conversion && act.conversion.skill) || '连环') : null
        });
      }

      // ① 通过技能按钮发动的转化牌
      //    ★【龙魂】把转化从「闪→杀」扩展成按花色的多方向：
      //      ♥→桃、♦→火【杀】、♣→闪、♠→无懈可击。这里只处理出牌阶段
      //      能主动「使用」的两类（桃 / 杀）；闪与无懈在响应链里结算。
      //      from 可以是牌型（龙胆）也可以是花色，统一走 Cards.matchesFrom()，
      //      to 的合法性由 Player.canUseAsType() 复核角色钩子。
      if (act.viaSkill) {
        const conv = act.conversion;
        if (!conv || (conv.scenes || ['play']).indexOf(act.scene || 'play') < 0 ||
            !SGS.Cards.matchesFrom(card, conv.from) ||
            !p.canUseAsType(card, conv.to)) {
          if (SGS.log) SGS.log('这次技能转化不合法。', 'warn');
          return false;
        }
        if (conv.to === 'tao') {
          if (p.hp >= p.maxHp) {
            if (SGS.log) SGS.log('体力已满，不能使用【桃】。', 'warn');
            return false;
          }
          await this.useTao(p, card, { asName: '桃', skillName: SGS.skillNameFor(p, 'play') });
          return true;
        }
        if (conv.to === 'sha') {
          if (!p.canPlaySha()) {
            if (SGS.log) SGS.log('本回合【杀】的使用次数已用完。', 'warn');
            return false;
          }
          // conv.asType（【龙魂】♦→'huosha'）让 useSha 带上火焰伤害属性
          return await this.useSha(p, card, true, null, {
            convertTo: conv.asType || null,
            skillName: SGS.skillNameFor(p, 'play')
          });
        }
        // ★【渐营】：出牌阶段限一次，将一张牌当「任意一张基本牌」使用。
        //   先让玩家从六种基本牌里选一种，再统一走 useConvertedBasic()。
        if (conv.to === 'basic') {
          if (p.jianyingUsed) {
            if (SGS.log) SGS.log('【渐营】本出牌阶段已经发动过了。', 'warn');
            return false;
          }
          // ★ 六选一按「此刻是否真的可用」置灰：满血桃 / 已用酒 / 杀次数用完
          //   或无合法目标，都不该再让玩家点进去才被规则层拒绝。
          const shaUsable = p.canPlaySha() &&
            this.listTargets(p, { type: 'sha' }, 'sha').length > 0;
          const choice = await this.askChoice(p, {
            desc: '【渐营】：将这张牌当哪一张基本牌使用？',
            choices: SGS.Cards.BASIC_TYPES.map((t) => ({
              label: '当【' + SGS.Cards.nameOf(t) + '】使用', value: t,
              disabled: t === 'tao' ? p.hp >= p.maxHp
                : t === 'jiu' ? p.jiuUsed
                  : SGS.Cards.isSha(t) ? !shaUsable : false
            }))
          });
          if (!choice) return false;
          return await this.useConvertedBasic(p, card, choice);
        }
        // ★【火计】：将一张红色手牌当【火攻】使用（锦囊层结算）。
        //   构造一张「当作牌」只用于目标 / 合法性判定；飞牌、离手、进弃牌堆
        //   都用原来的实体牌，避免弃牌堆里混进假牌。
        if (conv.to === 'huogong' || SGS.Cards.isTrick(conv.to)) {
          const asCard = Object.assign({}, card, {
            type: conv.to, name: SGS.Cards.nameOf(conv.to),
            // 标记「当作牌」：selectTargets 不再重复写【连环】的额外目标日志
            viaSkill: true
          });
          // ★ 牌语音改由 Tricks.use() 在「目标选定之后」统一播，
          //   取消目标选择时不再白播（无中生有等无需手动选目标的牌时序不变）。
          return await SGS.Tricks.use(this, p, asCard, {
            realCard: card, asName: SGS.Cards.nameOf(conv.to),
            asType: conv.to,
            // ★ 铁索连环固定取转化项自己的技能名，避免获得【火计】后
            //   buttonName('play') 变成火计，把 ♣ 转化误记成发动火计
            skillName: conv.to === 'tiesuolianhuan'
              ? (conv.skill || '连环') : SGS.skillNameFor(p, 'play'),
            // ★ 需要选目标的转化技（【破竹】）：技能大字 / 语音交给
            //   Tricks.use 在目标选定之后播 —— 选素材、点技能按钮时不响，
            //   取消选目标也不会白播。没标 announceAfterTarget 的技能
            //   （火计 / 看破 / 连环 / 渐营）各有自己的播报点，不重复。
            announceSkill: conv.announceAfterTarget
              ? (conv.skill || SGS.skillNameFor(p, 'play')) : null
          });
        }
        if (SGS.log) SGS.log('这张牌不能在此阶段发动该转化。', 'warn');
        return false;
      }

      // ★【无懈可击】是响应专用锦囊：没有正在结算、可被抵消的目标锦囊牌
      //   时不能主动使用。UI 已把【使用】按钮置灰；这里做规则层复核，
      //   避免绕过界面时先播了牌语音才被 Tricks.canUse 拒绝。
      //   注意必须放在 viaSkill 之后 ——【渐营】可以把这张牌当基本牌使用。
      if (SGS.Cards.defs[card.type] && SGS.Cards.defs[card.type].responseOnly) {
        if (SGS.log) {
          SGS.log('【' + card.name + '】只能在目标锦囊牌生效前作为响应打出，' +
            '当前没有可抵消的目标锦囊牌，不能主动使用。', 'warn');
        }
        return false;
      }

      // ② 普通出牌只认牌面：杀 / 桃 可直接打出
      if (card.type === 'tao') {
        if (p.hp >= p.maxHp) {
          if (SGS.log) SGS.log('体力已满，不能使用【桃】。', 'warn');
          return false;
        }
        this.playCardVoice(p, card, 'tao');
        await this.useTao(p, card);
        return true;
      }

      // 【杀】家族：普通杀 / 火杀 / 雷杀，共用出杀次数与选目标流程
      if (SGS.Cards.isSha(card.type)) {
        if (!p.canPlaySha()) {
          if (SGS.log) SGS.log('本回合【杀】的使用次数已用完。', 'warn');
          return false;
        }
        return await this.useSha(p, card, false);
      }

      if (card.type === 'jiu') {
        if (p.jiuUsed) {
          if (SGS.log) SGS.log('本回合已经使用过【酒】了。', 'warn');
          return false;
        }
        this.playCardVoice(p, card, 'jiu');
        return await this.useJiu(p, card);
      }

      // ③ 装备牌：不弹目标选择，飞到对应装备槽，装上后效果立即生效
      if (SGS.Cards.isEquip(card.type)) {
        this.playCardVoice(p, card, card.type);
        return await this.useEquip(p, card);
      }

      // ④ 锦囊牌：按牌面直接使用，无需技能按钮，效果结算交给 tricks.js
      //    （合法性校验含「其他有牌角色」与「距离为 1」判定；
      //     牌语音由 Tricks.use() 在目标确定后统一播）
      if (SGS.Cards.isTrick(card.type)) {
        return await SGS.Tricks.use(this, p, card);
      }

      // ⑤ 可经技能转化的牌：提醒玩家去点技能按钮（龙胆当杀 / 龙魂按花色当桃）
      const asShaConvert = p.canUseAsType(card, 'sha');
      if (asShaConvert || p.canUseAsType(card, 'tao')) {
        if (SGS.log) {
          SGS.log('【' + card.name + '】需发动【' + SGS.skillNameFor(p, 'play') + '】才能当【' +
            (asShaConvert ? '杀' : '桃') + '】使用，请先点击技能按钮。', 'warn');
        }
        return false;
      }

      if (SGS.log) SGS.log('这张牌在当前阶段无法使用。', 'warn');
      return false;
    }

    /**
     * ★【渐营】出牌阶段限一次：把一张牌当「任意一张基本牌」使用。
     *   六种基本牌：杀 / 闪 / 桃 / 酒 / 火杀 / 雷杀。
     *   规则要点：
     *     · 转化后的牌**点数与原牌一致**（直接沿用 card.rank）。
     *     · 若本阶段「使用的上一张牌」有花色，则此牌花色视为与该牌相同
     *       （影响仁王盾的颜色判定与下一次渐营的同花色比较）。
     *     · 实体牌仍是原来那张：飞牌 / 离手 / 进弃牌堆都用 realCard，
     *       只在规则判定层用「当作牌」，弃牌堆不会被改写成别的基本牌。
     * @returns {Promise<boolean>} 是否成功使用
     */
    async useConvertedBasic(p, card, type, ctx) {
      ctx = ctx || {};
      if (!card || !(SGS.Zones && SGS.Zones.findConversionCard
        ? SGS.Zones.findConversionCard(p, card.id)
        : p.hand.some((c) => c.id === card.id))) return false;
      if (SGS.Cards.BASIC_TYPES.indexOf(type) < 0) return false;
      if (p.jianyingUsed) {
        if (SGS.log) SGS.log('【渐营】本出牌阶段已经发动过了。', 'warn');
        return false;
      }
      const prev = (p.playLog || []).slice(-1)[0] || null;
      const suit = (prev && prev.suit) ? prev.suit : (card.suit || '');
      const color = (suit === '\u2665' || suit === '\u2666') ? 'red'
        : (suit === '\u2660' || suit === '\u2663') ? 'black'
          : (card.color || null);
      const asCard = Object.assign({}, card, {
        type: type, name: SGS.Cards.nameOf(type),
        suit: suit, color: color,
        damageType: SGS.Cards.damageTypeOf({ type: type })
      });
      const common = { realCard: card, asType: type, suit: suit, skillName: '渐营' };

      // 先做与目标牌型相关的合法性检查（不通过则不消耗「限一次」）
      // ★ 青龙偃月刀追加杀是技能额外提供的一张【杀】，不占常规出杀次数，
      //   所以 ctx.noShaCount 时跳过「次数已用完」的拦截（渐营条件仍需满足）。
      if (SGS.Cards.isSha(type) && !ctx.noShaCount && !p.canPlaySha()) {
        if (SGS.log) SGS.log('本回合【杀】的使用次数已用完。', 'warn');
        return false;
      }
      // ★ 与【渐营】选项置灰同口径：没有合法目标也拒绝转化（青龙追加杀
      //   已有 chosenTarget，不受影响）。
      if (SGS.Cards.isSha(type) && !ctx.chosenTarget &&
          this.listTargets(p, asCard || card, 'sha').length === 0) {
        if (SGS.log) SGS.log('当前没有【杀】的合法目标，不能这样转化。', 'warn');
        return false;
      }
      if (type === 'tao' && p.hp >= p.maxHp) {
        if (SGS.log) SGS.log('体力已满，不能使用【桃】。', 'warn');
        return false;
      }
      if (type === 'jiu' && p.jiuUsed) {
        if (SGS.log) SGS.log('本回合已经使用过【酒】了。', 'warn');
        return false;
      }
      p.jianyingUsed = true;
      // ★ 渐营按「选中的基本牌」播牌语音（酒 / 火杀 / 闪…），
      //   包装层传的是 'basic' 查不到素材，由这里补，不会重复。
      this.playCardVoice(p, card, type);
      if (SGS.log) {
        SGS.log(p.name + ' 发动【渐营】，将【' + card.name + '】当【' +
          SGS.Cards.nameOf(type) + '】使用' +
          (prev && prev.suit ? '（花色视为 ' + suit + '）' : '') + '。', 'sys');
      }

      if (SGS.Cards.isSha(type)) {
        return await this.useSha(p, asCard, false, ctx.chosenTarget || null,
          Object.assign({}, common, ctx.shaOpts || {}));
      }
      if (type === 'tao') {
        await this.useTao(p, asCard, Object.assign({}, common, { asName: '桃' }));
        return true;
      }
      if (type === 'jiu') {
        await this.useJiu(p, asCard, common);
        return true;
      }
      // 出牌阶段「当【闪】使用」没有实际效果：亮出并弃置即可（仍算使用过牌）
      await this.presentCard(card, p, { dest: 'showcase', asName: '闪' });
      await this.discardConsumed(p, card);
      await this.noteUsedCard(p, card, common);
      if (SGS.log) SGS.log(p.name + ' 当【闪】使用（出牌阶段无额外效果）。', 'sys');
      this.ui.render(this);
      return true;
    }

    /**
     * 使用【酒】（出牌阶段）：本回合下一张【杀】伤害 +1，每回合限一次。
     * 濒死时的【酒】自救走 brink()，不受这里的次数限制、也不置伤害加成。
     */
    async useJiu(p, card, opts) {
      opts = opts || {};
      const real = opts.realCard || card;
      await this.noteUsedCard(p, real, { suit: opts.suit, asType: opts.asType || 'jiu' });
      await this.presentCard(real, p, { dest: 'showcase' });
      await this.discardConsumed(p, real);
      p.jiuUsed = true;
      p.jiuBuff = true;
      if (SGS.log) {
        SGS.log(p.name + ' 使用【酒】，本回合下一张【杀】伤害 +1。', 'sys');
      }
      this.ui.render(this);
      await SGS.sleep(220);
      return true;
    }

    /**
     * ★【铁索连环】重铸：出牌阶段弃置此牌并摸一张牌。
     * 明确「不视为使用」：不进 Tricks.use()、不改任何使用计数；
     * 弃牌照常走 presentCard 动画，展示区标「重铸」。
     * opts.skillName（【连环】♣ 转化重铸）= 写发动记录，UI 据此播语音。
     */
    async reforge(p, card, opts) {
      opts = opts || {};
      if (opts.skillName && SGS.log) {
        SGS.log(p.name + ' 发动【' + opts.skillName + '】，将【' +
          card.name + '】当【铁索连环】重铸。', 'sys');
      }
      await this.presentCard(card, p, { dest: 'showcase', note: '重铸' });
      await this.discardConsumed(p, card);
      if (SGS.log) {
        SGS.log(p.name + ' 重铸【铁索连环】：弃置后摸一张牌（不视为使用）。', 'sys');
      }
      this.ui.render(this);
      const got = await this.drawCards(p, 1);
      if (SGS.log) SGS.log(p.name + ' 重铸摸了 ' + got.length + ' 张牌。', 'sys');
      this.ui.render(this);
      return true;
    }

    /**
     * ★ 一次性主动技（【涅槃】等）的统一入口。
     * 规则层只认角色文件在 skill.actions 里声明的名字与场景；
     * 「每局一次」的状态记在 player.usedSkillActions，不随回合重置。
     */
    async useSkillAction(player, name, scene) {
      if (!SGS.canUseSkillAction(player, name, scene)) return false;
      const action = SGS.findSkillAction(player, name, scene);
      if (!action) return false;
      if (action.once !== false) {
        if (!player.usedSkillActions) player.usedSkillActions = {};
        player.usedSkillActions[name] = true;
      }
      // 和日志兜底同一入口，skillFX 自带短时去重，不会播两遍。
      // ★ action.announce === false：由 action.run() 自己在「选完目标」等
      //   更合适的时机播一次（【翦灭】要求语音在选完目标后只响一次，
      //   点按钮就播会导致取消选目标也响、并与 run() 内的播放重复）。
      if (action.announce !== false) this.announceSkill(player, name);
      const ok = await action.run(this, player, scene || 'play');
      this.ui.render(this);
      // 一次性 / 限次技能用掉后立刻刷新右下按钮，不等下一次 waitPlay
      if (this.ui && typeof this.ui.refreshActions === 'function') {
        this.ui.refreshActions();
      }
      return ok !== false;
    }

    /**
     * ★ 弃置一个角色「区域里的所有牌」：手牌区 + 装备区四槽 + 判定区。
     * 飞牌逐张走 presentCard（自动识别装备槽起点），离场统一走 Zones.take
     * 并进弃牌堆；装备失去照常结算【白银狮子】回血。
     * @returns {Array} 被弃置的 SGS.Zones 条目
     */
    async discardAllZoneCards(player, opts) {
      if (!player) return [];
      opts = opts || {};
      const entries = (SGS.Zones && typeof SGS.Zones.list === 'function')
        ? SGS.Zones.list(player) : [];
      if (!entries.length) return [];
      for (const e of entries) {
        await this.presentCard(e.card, player, {
          dest: 'showcase', note: opts.note || '弃置'
        });
      }
      for (const e of entries) {
        const removed = (SGS.Zones && typeof SGS.Zones.take === 'function')
          ? SGS.Zones.take(player, e.id) : null;
        // Zones.take() 返回的是区域条目 {card, zone...}，弃牌堆要收真牌
        const card = removed && removed.card ? removed.card : removed;
        if (!card) continue;
        if (this.deck && typeof this.deck.discard === 'function') {
          this.deck.discard(card);
        }
        if (e.zone === 'equip' && typeof this.onEquipmentLost === 'function') {
          await this.onEquipmentLost(player, card);
        }
      }
      this.ui.render(this);
      return entries;
    }

    /**
     * 装备一张牌：从手牌区（自己）/ 角色框（AI）平滑飞到对应装备槽，
     * 落地后才离手、装上并渲染装备区 UI；同槽旧装备被替换后飞入展示区、
     * 再进入弃牌堆。装备牌本身不进弃牌堆（它在装备区里），也不需要选目标。
     * 所有效果都是锁定技，装上即由 equipment.js 的查询函数持续生效。
     */
    async useEquip(p, card) {
      const slot = SGS.Equipment.slotOf(card);
      if (!slot) return false;
      await this.noteUsedCard(p, card);
      const spec = SGS.Cards.equipOf(card.type) || {};
      const old = (p.equips && p.equips[slot]) || null;

      let equipSfxPlayed = false;
      const playEquipSfx = () => {
        if (equipSfxPlayed) return;
        equipSfxPlayed = true;
        try {
          if (SGS.Audio && typeof SGS.Audio.playEquip === 'function') SGS.Audio.playEquip();
        } catch (e) { /* 音频失败不影响结算 */ }
      };
      await this.presentCard(card, p, {
        dest: 'equip', slot: slot, toPlayer: p,
        onArrive: () => {
          p.removeCard(card.id);
          p.equip(card);                       // mount 会替换同槽旧牌
          // ★「使用装备牌将其置入装备区」的作用音效，落地瞬间播
          playEquipSfx();
          this.ui.render(this);                // 落地瞬间装备区出现独立 UI
        }
      });
      // 假界面 / 没有 onArrive 回调的 presentCard：只要牌确实已落到装备区，补播一次
      if (p.equips && p.equips[slot] === card) playEquipSfx();

      // ★ 被替换下来的旧装备：从原装备槽飞入中央展示区，再进弃牌堆。
      //   与【过河拆桥】/【寒冰剑】弃置牌保持一致的公开方式，
      //   展示区里的牌保留到本角色回合结束由 runTurn 统一清空。
      if (old) {
        await this.presentCard(old, p, {
          from: 'equip', slot: slot, dest: 'showcase', note: '替换弃置'
        });
        this.deck.discard(old);
      }

      if (SGS.log) {
        SGS.log(
          p.name + ' 装备【' + card.name + '】' +
          (spec.note ? '（' + spec.note + '）' : '') + '。' +
          (old ? '替换下的【' + old.name + '】进入弃牌堆。' : ''),
          'equip'
        );
      }
      this.ui.render(this);
      await SGS.sleep(220);

      // ★ 失去装备的触发：「替换」也算失去。若被换下的是【白银狮子】，
      //   拥有者回复 1 点体力。其它失去路径（过河拆桥 / 顺手牵羊）在
      //   tricks.js 里同样调用本方法，保证所有入口一致。
      if (old) await this.onEquipmentLost(p, old);
      return true;
    }

    /**
     * 角色失去装备区里的一张牌后的触发效果（统一的唯一入口）。
     * 目前只有【白银狮子】：回复 spec.loseHeal 点体力（满血时不溢出）。
     * 「失去」包括：被同槽新装备替换、被【过河拆桥】弃置、被【顺手牵羊】
     * 牵走，以及将来任何卸下装备的路径 —— 调用方负责在移除后通知这里。
     * @returns {Promise<boolean>} 是否实际回复了体力
     */
    async onEquipmentLost(player, card) {
      const heal = (SGS.Equipment && card) ? SGS.Equipment.loseHealOf(card) : 0;
      if (!heal) return false;
      if (player.hp >= player.maxHp) {
        if (SGS.log) {
          SGS.log(player.name + ' 失去【' + card.name + '】，但体力已满，无需回复。', 'sys');
        }
        return false;
      }
      this.healPlayer(player, heal);
      if (SGS.log) {
        SGS.log(player.name + ' 失去装备区里的【' + card.name + '】，回复 ' +
          heal + ' 点体力，至 ' + player.hp + '/' + player.maxHp + '。', 'heal');
      }
      this.ui.render(this);
      await SGS.sleep(260);
      return true;
    }

    /**
     * 使用【桃】：飞入展示区，回复 1 点体力。
     * opts.asName 给转化牌打「当作【桃】」标签；opts.skillName 写发动技能的日志。
     * 旧调用（AI 吃桃 / 桃园结义）不传 opts，行为完全不变。
     */
    async useTao(p, card, opts) {
      opts = opts || {};
      const real = opts.realCard || card;
      await this.noteUsedCard(p, real, { suit: opts.suit, asType: opts.asType || 'tao' });
      await this.presentCard(real, p, {
        dest: 'showcase', asName: opts.asName || null
      });
      await this.discardConsumed(p, real);
      this.healPlayer(p, 1);
      if (SGS.log) {
        const head = opts.skillName
          ? p.name + ' 发动【' + opts.skillName + '】，将【' + card.name + '】当【桃】使用'
          : p.name + ' 使用【桃】';
        SGS.log(head + '，体力恢复至 ' + p.hp + '/' + p.maxHp + '。', 'heal');
      }
      this.ui.render(this);
      await SGS.sleep(220);
    }

    /**
     * 【丈八蛇矛】主动转化：把两张手牌当一张普通【杀】**使用**。
     * 触发条件在 ui.js：点玩家装备区「武器」栏里的丈八蛇矛 → 选两张手牌
     * → 确认，act = { type:'use', zhangba:true, cards:[c1,c2] }。
     *
     * 两张牌都从手牌区飞入展示区并进弃牌堆，然后构造一张「当作牌」交给
     * useSha(..., { consumed:true, equipConvert:true }) 走完整的选目标 /
     * 黄线 / 闪 / 伤害流程。
     *
     * ★ 颜色按素材（SGS.Cards.zhangbaShaColor）：两红→红色、两黑→黑色、
     *   一红一黑→无色；永远无点数花色、伤害属性固定 normal（不带火 / 雷）。
     *   因此两黑的黑杀会被【仁王盾】挡下，素材是【火杀】也不会变火焰伤害。
     *   equipConvert 标记同时阻止【朱雀羽扇】把这次杀改成火杀。
     * @returns {Promise<boolean>} 是否成功使用
     */
    async useZhangbaSha(p, cards) {
      if (!SGS.Equipment || !SGS.Equipment.hasZhangba(p)) {
        if (SGS.log) SGS.log('没有装备【丈八蛇矛】，无法发动转化。', 'warn');
        return false;
      }
      if (!Array.isArray(cards) || cards.length !== 2 ||
          cards[0].id === cards[1].id ||
          !cards.every((c) => p.hand.find((x) => x.id === c.id))) {
        if (SGS.log) SGS.log('【丈八蛇矛】需要选择两张不同的手牌。', 'warn');
        return false;
      }
      if (!p.canPlaySha()) {
        if (SGS.log) SGS.log('本回合【杀】的使用次数已用完。', 'warn');
        return false;
      }
      if (!this.listTargets(p, { type: 'sha' }, 'sha').length) {
        if (SGS.log) SGS.log('当前没有【杀】的合法目标。', 'warn');
        return false;
      }

      // ★ 两张实体牌一次性飞入展示区（此时仍在手牌 DOM 里，起点最准）
      await this.presentCards(cards, p, { asName: '杀' });
      // ★ 丈八蛇矛明确写「两张手牌」：逐张走统一离场入口，牌只可能来自手牌
      await this.discardConsumed(p, cards[0]);
      await this.discardConsumed(p, cards[1]);
      this.ui.render(this);

      const colorName = SGS.Cards.zhangbaShaColorName(cards);
      const asSha = {
        id: SGS.uid('zhangba'), type: 'sha', name: '杀', category: 'basic',
        damageType: 'normal', color: SGS.Cards.zhangbaShaColor(cards),
        rank: '', suit: '',
        image: null, equip: null, zhangba: true
      };
      if (SGS.log) {
        SGS.log('【丈八蛇矛】两张手牌转化为' + colorName +
          '普通【杀】（无点数花色，不带火 / 雷属性伤害）。', 'sys');
      }
      return await this.useSha(p, asSha, true, null,
        { consumed: true, equipConvert: true });
    }

    /**
     * 【丈八蛇矛】把两张手牌当【杀】**打出**（响应南蛮入侵 / 决斗）。
     * 两张牌移手并弃置、飞入展示区，返回一个虚拟响应，下游不会重复弃牌。
     * 颜色与「使用」同规则（两红 / 两黑 / 一红一黑），响应打出的杀不带
     * 火 / 雷属性；虚拟响应不携带实体牌，颜色只体现在日志文案里。
     */
    async zhangbaRespond(player, cards) {
      if (!SGS.Equipment || !SGS.Equipment.hasZhangba(player) ||
          !Array.isArray(cards) || cards.length !== 2 ||
          cards[0].id === cards[1].id ||
          !cards.every((c) => player.hand.find((x) => x.id === c.id))) {
        if (SGS.log) SGS.log('【丈八蛇矛】响应需要两张不同的手牌。', 'warn');
        return null;
      }
      // ★ 两张手牌当【杀】打出：虚拟响应没有单张实体牌，这里补一张杀音
      this.playCardVoice(player, cards[0], 'sha');
      await this.presentCards(cards, player, { dest: 'showcase', asName: '杀' });
      await this.discardConsumed(player, cards[0]);
      await this.discardConsumed(player, cards[1]);
      const colorName = SGS.Cards.zhangbaShaColorName(cards);
      if (SGS.log) {
        SGS.log(player.name + ' 发动【丈八蛇矛】，将两张手牌当' +
          colorName + '普通【杀】打出。', 'sha');
      }
      this.ui.render(this);
      return {
        card: null, viaSkill: true, virtual: true,
        sourceName: '丈八蛇矛',
        virtualText: '发动【丈八蛇矛】将两张手牌当' + colorName + '普通【杀】打出'
      };
    }

    /**
     * 【寒冰剑】：一次选出 n 张牌（不含判定区），按点击顺序依次弃置。
     * 展示区每张都标「寒冰剑弃置」；弃掉装备区的牌同样触发失去装备效果。
     * n 由调用方按「有几张就必须弃几张（最多 2）」算好。
     */
    async hanbingDiscard(user, target, n) {
      const entries = await this.pickDisposables(user, target, n);
      let done = 0;
      for (const entry of entries) {
        if (!entry || entry.zone === 'delayed') continue;
        await this.presentCard(entry.card, target, {
          from: 'hero', dest: 'showcase', note: '寒冰剑弃置'
        });
        this.deck.discard(entry.card);
        done++;
        if (SGS.log) {
          SGS.log(user.name + ' 弃置了 ' + target.name + ' 的【' +
            SGS.Zones.zoneText(entry) + '·' + entry.card.name + '】（第 ' +
            done + '/' + n + ' 张）。', 'sys');
        }
        this.ui.render(this);
        await SGS.sleep(220);
        // ★ 弃掉装备区的牌也算「失去装备」：白银狮子回血
        if (entry.zone === 'equip') await this.onEquipmentLost(target, entry.card);
      }
      return done;
    }

    /**
     * ★【麒麟弓】：杀造成伤害时弃掉目标装备区里的一张坐骑牌。
     * 只有一匹马就直接弃，两匹（+1 马与 -1 马同时装备）才弹面板让玩家点选；
     * 弃牌飞入展示区标「麒麟弓弃置」，并统一走 onEquipmentLost()。
     */
    async qilinDiscard(user, target) {
      const horses = SGS.Zones.disposable(target).filter((e) =>
        e.zone === 'equip' && (e.zoneKey === 'horsePlus' || e.zoneKey === 'horseMinus'));
      if (!horses.length) return 0;
      const entries = await this.pickDisposables(user, target, 1, {
        name: '麒麟弓', type: 'qilin', horseOnly: true,
        hint: '【麒麟弓】：请选择要弃置的一张坐骑牌。'
      });
      const entry = entries[0];
      if (!entry) return 0;
      await this.presentCard(entry.card, target, {
        from: 'equip', slot: entry.zoneKey, dest: 'showcase', note: '麒麟弓弃置'
      });
      this.deck.discard(entry.card);
      if (SGS.log) {
        SGS.log(user.name + ' 发动【麒麟弓】，弃置了 ' + target.name +
          ' 的【' + entry.card.name + '】。', 'sys');
      }
      this.ui.render(this);
      await SGS.sleep(220);
      if (this.onEquipmentLost) await this.onEquipmentLost(target, entry.card);
      return 1;
    }

    /** ★【古锭刀】锁定技：目标没有手牌时，这次【杀】伤害 +1 */
    shaDamageAmount(attacker, target, dmg) {
      if (SGS.Equipment && SGS.Equipment.hasGudingdao(attacker) &&
          (!target.hand || !target.hand.length)) {
        if (SGS.log) {
          SGS.log(attacker.name + ' 发动【古锭刀】，因 ' + target.name +
            ' 没有手牌，此【杀】伤害 +1。', 'sha');
        }
        return dmg + 1;
      }
      return dmg;
    }

    /**
     * ★【雌雄双股剑】：杀指定异性目标后，由目标二选一 ——
     *   ① 弃置一张手牌（飞入展示区标「雌雄双股剑弃置」）；
     *   ② 令使用者摸一张牌（走 drawCards 摸牌动画）。
     * 玩家侧选项走 ui.waitChoice，弃牌走 ui.waitPick（默认手牌选取动画）。
     */
    async cixiongEffect(user, target) {
      // ★ 目标手里没有牌时，「弃置一张手牌」这一项必须直接置灰：
      //   点进去只会打开一个无牌可选、也没有取消入口的选牌界面 ——
      //   玩家选不了、退不出，整局卡死。（用户实测到的 bug）
      const hasHand = !!(target && target.hand && target.hand.length);
      const choice = await this.askChoice(target, {
        name: '雌雄双股剑',
        desc: '【雌雄双股剑】：请选择一项',
        choices: [
          { label: '弃置一张手牌', value: 'discard', disabled: !hasHand },
          { label: '令 ' + user.name + ' 摸一张牌', value: 'draw' }
        ],
        context: 'cixiong'
      });
      if (choice !== 'discard' && choice !== 'draw') {
        this.ui.render(this);
        return;
      }
      if (choice === 'discard' && hasHand) {
        let id = null;
        if (SGS.isDecider(target) && this.ui && typeof this.ui.waitPick === 'function') {
          id = await this.ui.waitPick(target, this, {
            need: 1, confirmLabel: '弃置',
            hint: '【雌雄双股剑】：点选一张手牌弃置。'
          });
        }
        const card = (id && target.hand.find((c) => c.id === id)) || target.hand[0] || null;
        if (card) {
          target.removeCard(card.id);
          await this.presentCard(card, target, { dest: 'showcase', note: '雌雄双股剑弃置' });
          this.deck.discard(card);
          if (SGS.log) {
            SGS.log(target.name + ' 选择弃置一张手牌【' + card.name + '】（【雌雄双股剑】）。', 'sys');
          }
          this.ui.render(this);
          return;
        }
        // 走到这里说明「选了弃牌、其实一张牌都没有」（界面没拦住的老客户端 /
        // AI 决策与当前手牌不一致）→ 按规则退化成另一项，绝不留死局。
      }
      const got = await this.drawCards(user, 1);
      if (SGS.log) {
        SGS.log(user.name + ' 因【雌雄双股剑】摸了 ' + got.length + ' 张牌。', 'sys');
      }
      this.ui.render(this);
    }

    /**
     * 从目标「手牌 + 装备区」里一次选 n 张要弃置的牌（不含判定区）。
     * ★ 面板只弹一次，玩家点选顺序即弃牌顺序；AI / 无界面假 UI 返回的
     *   单张 id 或数组都兼容，不足的张数由随机兜底。
     */
    async pickDisposables(user, target, n, opts) {
      opts = opts || {};
      const name = opts.name || '寒冰剑';
      let ids = null;
      const useHandPick = !!opts.useHandPick && SGS.isDecider(target) &&
        this.ui && typeof this.ui.waitPick === 'function';
      if (this.ui && typeof this.ui.waitTrickCard === 'function' && !useHandPick) {
        ids = await this.ui.waitTrickCard(this, user, target,
          { name: name, type: opts.type || 'hanbing' },
          {
            excludeDelayed: true, need: n,
            horseOnly: !!opts.horseOnly,
            hint: opts.hint || ('【' + name + '】请一次点选 ' + n +
              ' 张手牌或装备牌（点击顺序 = 弃牌顺序）。')
          });
      } else if (useHandPick) {
        ids = await this.ui.waitPick(target, this, {
          need: n,
          allowEquip: true,
          confirmLabel: opts.confirmLabel || '确认弃置',
          cancelLabel: opts.cancelLabel || '不发动',
          hint: opts.hint || ('【' + name + '】从手牌区点牌，也可点左侧装备区选装备，选满 ' +
            n + ' 张后确认。')
        });
      }
      if (!Array.isArray(ids)) ids = ids ? [ids] : [];
      // ★ 候选池必须先按规则收窄（【麒麟弓】只要坐骑），不能相信 UI / AI
      //   返回的 id：返回了手牌等非坐骑牌时直接忽略，绝不能误弃。
      const poolOf = () => {
        let pool = SGS.Zones.disposable(target);
        if (opts.horseOnly) {
          pool = pool.filter((e) => e.zone === 'equip' &&
            (e.zoneKey === 'horsePlus' || e.zoneKey === 'horseMinus'));
        }
        return pool;
      };
      const entries = [];
      for (const id of ids) {
        if (entries.length >= n) break;
        if (entries.some((e) => e.id === id)) continue;
        if (!poolOf().some((e) => e.id === id)) continue;
        const taken = SGS.Zones.take(target, id);
        if (taken) entries.push(taken);
      }
      while (entries.length < n) {
        const pool = poolOf();
        if (!pool.length) break;
        const taken = SGS.Zones.take(target, pool[Math.floor(Math.random() * pool.length)].id);
        if (!taken) break;
        entries.push(taken);
      }
      return entries;
    }

    /**
     * ★ 找一条「把这张牌当【杀】使用/打出」的明确转化规则。
     *   只认 conversions 里 to==='sha' 的条目（龙魂 ♦→火杀、龙胆 闪→杀），
     *   刻意不认渐营那种 to==='basic' 的「六选一」，因为它需要另一套选牌 UI，
     *   且与青龙追加杀界面右下技能按钮的过滤口径（conversionsFor respond/sha）
     *   完全一致，不会出现「规则说能用但界面没按钮」或反之。
     *   返回的 conv.asType（如 'huosha'）交给 useSha 决定伤害属性。
     */
    shaConversionFor(player, card) {
      const sk = player && player.skill;
      if (!sk || !sk.conversions || !card) return null;
      return sk.conversions.find((c) =>
        c.to === 'sha' &&
        (c.scenes || ['play']).some((sc) => sc === 'play' || sc === 'respond') &&
        SGS.Cards.matchesFrom(card, c.from) &&
        typeof player.canUseAsType === 'function' &&
        player.canUseAsType(card, 'sha')) || null;
    }

    /**
     * ★ 找一条「把这张牌当任意基本牌」的渐营类转化规则。
     *   渐营 from='any'，所以手里任何一张牌都能当素材；必须同时满足
     *   「出牌阶段」「本阶段限一次还没用过」。青龙偃月刀的发动时机在
     *   出牌阶段，满足渐营「出牌阶段限一次」的条件，故也纳入候选。
     */
    basicConversionFor(player, card) {
      const sk = player && player.skill;
      if (!sk || !sk.conversions || !card || player.jianyingUsed) return null;
      return sk.conversions.find((c) =>
        c.to === 'basic' &&
        (c.scenes || ['play']).indexOf('play') >= 0 &&
        SGS.Cards.matchesFrom(card, c.from) &&
        typeof player.canUseAsType === 'function' &&
        player.canUseAsType(card, 'basic')) || null;
    }

    /**
     * ★【青龙偃月刀】：这次【杀】被【闪】抵消后，询问是否继续对同一目标
     *   使用一张【杀】。玩家从手牌区点选（天然能当【杀】的牌直接可选），
     *   AI 自动选一张。追加的杀由技能额外提供，不占本回合常规出杀次数。
     *   每追一杀都会消耗一张手牌，所以不存在无限循环。
     *
     * ★ 支持技能转化的【杀】：神赵云【龙魂】♦ 当火【杀】、赵云【龙胆】
     *   【闪】当【杀】等。旧版 candidates 只认 canUseAsSha()，手里只剩 ♦ 时
     *   连「发动青龙偃月刀」的询问都不弹，选牌界面又是 noSkillPlaceholder，
     *   右下完全没有【龙魂】按钮 —— 这正是玩家反馈的 bug。
     *   现在选牌界面带 skillNeed='sha' 的技能按钮，点进去走统一的
     *   openSkill → confirmSkill，回传 conversion；useSha 按 conv.asType
     *   结算火焰伤害，牌语音也跟着播【火杀】。
     */
    async qinglongFollow(attacker, target, displayName) {
      if (this.over || !SGS.Equipment || !SGS.Equipment.hasQinglong(attacker)) return false;
      // 目标可能已死 / 距离变化，仍需按与正常出杀一致的规则校验
      if (!this.listTargets(attacker, { type: 'sha' }, 'sha').includes(target)) return false;
      // ★「牌」= 手牌 + 装备区：渐营 / 龙魂这类写「牌」的转化，
      //   素材可以只剩装备区一张，也要能进入青龙追加杀的询问。
      const pool = this.conversionCardPool(attacker);
      const candidates = pool.filter((c) =>
        attacker.canUseAsSha(c) ||
        !!this.shaConversionFor(attacker, c) ||
        !!this.basicConversionFor(attacker, c));
      if (!candidates.length) return false;

      const yes = await this.askOptional(attacker, {
        name: '青龙偃月刀',
        desc: '【青龙偃月刀】：这张【' + displayName +
          '】被【闪】抵消，是否继续使用一张【杀】攻击 ' + target.name + '？',
        yes: '发动【青龙偃月刀】', no: '不发动',
        context: 'qinglong', target: target
      });
      if (!yes || this.over) return false;

      let follow = candidates[0];
      let conv = this.shaConversionFor(attacker, follow) ||
        this.basicConversionFor(attacker, follow);
      if (SGS.isDecider(attacker) && this.ui && typeof this.ui.waitPick === 'function') {
        const canConvert = pool.some(
          (c) => !attacker.canUseAsSha(c) &&
            (!!this.shaConversionFor(attacker, c) ||
             !!this.basicConversionFor(attacker, c)));
        // ★ 右下会把该角色的全部技能都列出来；这里点出此刻真正能发动的几个
        const activeNames = [];
        const add = (n) => { if (n && activeNames.indexOf(n) < 0) activeNames.push(n); };
        pool.forEach((c) => {
          const cv = this.shaConversionFor(attacker, c) ||
            this.basicConversionFor(attacker, c);
          if (cv && !attacker.canUseAsSha(c)) add(cv.skill || SGS.skillNameFor(attacker, 'play'));
        });
        const hint = '【青龙偃月刀】：请从手牌区点选一张【杀】继续使用' +
          (canConvert && activeNames.length
            ? '，或点右下【' + activeNames.join('】【') + '】用其他牌当【杀】' : '') + '。';
        const pick = await this.ui.waitPick(attacker, this, {
          need: 1,
          // 普通选牌仍只放行「天然可用」的牌；转化牌必须点技能按钮才能选，
          // 与其它场景「主动技必须点按钮」的口径一致。
          filter: (c) => attacker.canUseAsSha(c),
          confirmLabel: '使用【杀】', cancelLabel: '不继续使用',
          hint: hint,
          rejectHint: '这张牌不能当【杀】使用；若要用技能转化，请点右下技能按钮。',
          // ★ 右下技能栏列出全部技能：play 场景（青龙时机在出牌阶段）
          //   + need ['sha','basic'] 放行龙魂 / 龙胆 / 渐营，其余灰色占位。
          //   noShaCount：追加杀不占常规出杀次数，渐营按钮不被次数误置灰。
          skillNeed: ['sha', 'basic'], skillScene: 'play',
          skillNoShaCount: true
        });
        if (!pick) return false;
        if (typeof pick === 'object' && pick.card) {
          // 技能按钮路径：confirmSkill 回传 {card, viaSkill, conversion, scene}
          // ★ 按 conversion.to 复核：渐营 to='basic' 用 canUseAsType(c,'basic')，
          //   龙魂 / 龙胆 to='sha' 用 canUseAsType(c,'sha')。
          const c = pick.card, cv = pick.conversion;
          const entry = this.conversionCardEntry(attacker, c.id);
          if (!cv || !SGS.Cards.matchesFrom(c, cv.from) ||
              !entry || !attacker.canUseAsType(c, cv.to)) return false;
          follow = entry.card || c;
          conv = cv;
        } else {
          // 普通选牌路径：回传牌 id（字符串），保持旧调用契约
          follow = attacker.hand.find((x) => x.id === pick && attacker.canUseAsSha(x));
          if (!follow) return false;
          conv = this.shaConversionFor(attacker, follow);
        }
      }
      if (SGS.log) {
        SGS.log(attacker.name + ' 发动【青龙偃月刀】，对 ' + target.name +
          ' 继续使用一张【' + follow.name + '】。', 'sha');
      }
      // ★【渐营】：出牌阶段限一次把一张牌当任意基本牌使用。青龙偃月刀
      //   要求「继续使用一张【杀】」，所以六选一只列三种杀（杀 / 火杀 /
      //   雷杀）；选完后完整走渐营：限一次、花色视为上一张牌的花色、
      //   触发渐营摸牌判定、实体牌进弃牌堆，再对同一目标追加这张杀。
      if (conv && conv.to === 'basic') {
        const shaTypes = SGS.Cards.BASIC_TYPES.filter((t) => SGS.Cards.isSha(t));
        const choice = await this.askChoice(attacker, {
          desc: '【青龙偃月刀】需要继续使用一张【杀】；【渐营】把这张牌当哪张基本牌使用？',
          choices: shaTypes.map((t) => ({
            label: '当【' + SGS.Cards.nameOf(t) + '】使用', value: t
          }))
        });
        if (!choice || shaTypes.indexOf(choice) < 0) return false;
        return await this.useConvertedBasic(attacker, follow, choice, {
          chosenTarget: target, noShaCount: true,
          shaOpts: { noShaCount: true }
        });
      }
      // ★ conv.asType：龙魂 ♦→'huosha'，让追加的杀带火焰伤害、破藤甲。
      //   龙胆没有 asType → null，按普通【杀】结算，行为不变。
      const convertTo = conv ? (conv.asType || null) : null;
      return await this.useSha(attacker, follow, !SGS.Cards.isSha(follow.type), target,
        { noShaCount: true, convertTo: convertTo });
    }

    /**
     * 使用【杀】家族（普通杀 / 火杀 / 雷杀，或龙胆 / 丈八蛇矛转化出的杀）：
     * 先选目标 → 黄线动画 → 目标需打出【闪】。
     * 目标由 selectTarget 显式选择（1v1 也要点）；取消时返回 false、牌不消耗。
     * 伤害属性由 SGS.Cards.damageTypeOf(card) 决定，交给 damage() 结算。
     *
     * opts：
     *   consumed      true = 实体牌已由调用方处理（丈八蛇矛的两张手牌），
     *                 不再 here 飞牌 / 移手 / 弃置
     *   equipConvert  true = 丈八蛇矛转化，日志写「将两张手牌当【杀】」
     *
     * ★【青釭剑】：armorNegated 贯穿整次杀结算 —— 防具挡杀判定、
     *   八卦阵判定闪、藤甲火焰加伤、白银狮子减伤全部跳过。
     * @returns {Promise<boolean>} 是否成功使用
     */
    async useSha(attacker, card, viaSkill, chosenTarget, opts) {
      opts = opts || {};
      // AI 由 ai.js 直接调用、未传标记时，按牌面推断它是在发动转化技能。
      // 火杀 / 雷杀本来就是杀，不算「转化」。
      if (viaSkill === undefined) viaSkill = !SGS.Cards.isSha(card.type);
      const converted = viaSkill && !SGS.Cards.isSha(card.type);
      const equipConvert = !!opts.equipConvert;
      // ★【龙魂】♦ 当火【杀】：转化后真正当作的牌型。只影响伤害属性 /
      //   显示名 / 防具判定，牌堆里仍然是原来那张 ♦ 牌（removeCard + discard
      //   都吃原 card），不会把弃牌堆里的【闪】悄悄改写成【火杀】。
      const convertTo = opts.convertTo || null;
      const convertedName = convertTo ? SGS.Cards.nameOf(convertTo) : '杀';
      const armorNegated = SGS.Equipment ? SGS.Equipment.ignoresArmor(attacker) : false;

      // ★ 龙胆把【闪】当【杀】时，目标规则必须按【杀】算：
      //   物理牌面是【闪】(self)，若不指定 asType，listTargets 会把使用者自己
      //   当成唯一「合法目标」，导致对手卡不高亮、点击后提示「不是闪的合法目标」。
      //   构造一张只用于展示 / 选目标的「当作牌」，牌堆状态仍用原 card 结算。
      const asCard = converted
        ? Object.assign({}, card, {
          type: convertTo || 'sha', name: convertedName
        })
        : card;
      const targets = this.listTargets(attacker, card, 'sha');
      // ★【方天画戟】：这张【杀】是手中最后一张牌时，可额外选至多两个目标。
      //   后续目标在牌飞入展示区后依次复用同一次杀结算，不再弃牌、不再计次数。
      const fangtianReady = !opts.consumed && !opts.noShaCount &&
        SGS.Equipment && SGS.Equipment.hasFangtian(attacker) &&
        attacker.hand.length === 1 && attacker.hand[0].id === card.id &&
        targets.length > 1;
      let extraTargets = [];
      let target;
      if (!chosenTarget && fangtianReady) {
        let picks = null;
        if (SGS.isDecider(attacker)) {
          if (this.ui && typeof this.ui.waitChainTargets === 'function') {
            picks = await this.ui.waitChainTargets(attacker, asCard, targets, this, 1, 3,
              '【方天画戟】这是你最后一张手牌，此【杀】可指定 1~3 名目标。点选后按【确认】。');
          }
        } else {
          picks = targets.slice(0, 3);   // AI 尽量连上所有目标
        }
        if (!picks || !picks.length) return false;
        target = picks[0];
        extraTargets = picks.slice(1);
      } else {
        target = chosenTarget || await this.selectTarget(attacker, asCard, targets);
        if (!target) return false; // 玩家取消选择目标，回到出牌阶段
      }

      // 先让牌从来源平滑飞入展示区（此时它仍在手牌 DOM 里，起点最准）
      // ★ opts.realCard：渐营等「当作牌」只用于规则判定，飞牌 / 离手 /
      //   进弃牌堆都用原来的实体牌，弃牌堆不会被改写成别的基本牌。
      const real = opts.realCard || card;
      if (!opts.consumed) {
        await this.presentCard(real, attacker, {
          asName: converted ? convertedName : null
        });
        await this.discardConsumed(attacker, real);
      }
      // ★ 方天画戟的额外目标会复用本次杀（consumed/noShaCount），
      //   不能再写一次出牌记录，否则【渐营】会误判成「又用了一张牌」。
      if (!opts.consumed) {
        await this.noteUsedCard(attacker, real, {
          suit: opts.suit,
          asType: opts.asType || (SGS.Cards.isSha(card.type) ? card.type : 'sha')
        });
        // ★【咆哮】是纯 shaLimit 钩子、没有「发动【X】」日志，日志兜底识别不到。
        //   张飞每次使用【杀】都算发动这个锁定技，这里显式播一次技能大字。
        //   只认「角色技能」提供的无限杀（hook('shaLimit', 1) === Infinity），
        //   【诸葛连弩】是装备层、不进 hook，不会被误播；方天额外目标已由
        //   !opts.consumed 排除。技能横幅自带 700ms 去重，AI 连出杀不会刷屏。
        if (attacker.skill && attacker.skill.name && attacker.hook &&
            attacker.hook('shaLimit', 1) === Infinity) {
          this.announceSkill(attacker, attacker.skill.name);
        }
      }
      if (!opts.noShaCount) attacker.shaUsed++;

      // ★【雌雄双股剑】：指定异性角色为目标后，目标在「弃一张手牌 / 令你摸一张」间选择
      if (SGS.Equipment && SGS.Equipment.hasCixiong(attacker) &&
          target.gender && attacker.gender && target.gender !== attacker.gender) {
        const yes = await this.askOptional(attacker, {
          name: '雌雄双股剑',
          desc: '【雌雄双股剑】：是否令 ' + target.name + ' 选择弃置一张手牌，或令你摸一张牌？',
          yes: '发动【雌雄双股剑】', no: '不发动',
          context: 'cixiong', target: target
        });
        if (yes) await this.cixiongEffect(attacker, target);
      }

      // ★【酒】加成：只作用于「本回合下一张【杀】」，不论命中与否都立即消耗。
      //   濒死用酒自救不经过这里，因此不会被误当作伤害加成。
      const dmg = attacker.jiuBuff ? 2 : 1;
      attacker.jiuBuff = false;
      const baseType = convertTo
        ? SGS.Cards.damageTypeOf({ type: convertTo })
        : SGS.Cards.damageTypeOf(card);
      let dmgType = baseType;
      let displayName = convertTo ? convertedName : card.name;

      // ★【朱雀羽扇】：使用普通【杀】时可改为火【杀】（「可以」类，先询问）。
      //   只改伤害属性与显示名，牌本身仍是原来那张普通杀；转化后【藤甲】
      //   不再把它当「普通【杀】」挡下，火焰伤害还会触发藤甲 +1。
      if (!converted && !equipConvert && card.type === 'sha' &&
          SGS.Equipment && SGS.Equipment.weaponFlag(attacker, 'zhuque')) {
        const yes = await this.askOptional(attacker, {
          name: '朱雀羽扇',
          desc: '【朱雀羽扇】：是否将这张普通【杀】改为火【杀】？',
          yes: '改为火【杀】', no: '保持普通【杀】',
          context: 'zhuque'
        });
        if (yes) {
          dmgType = 'fire';
          displayName = '火杀';
          if (SGS.log) {
            SGS.log(attacker.name + ' 发动【朱雀羽扇】，将普通【杀】改为火【杀】。', 'sha');
          }
        }
      }
      const dmgName = dmgType === 'fire' ? '火焰' : dmgType === 'thunder' ? '雷电' : '普通';
      // 防具判定要用「转化后」的属性（朱雀羽扇改火杀、【龙魂】♦ 当火杀后
      // 藤甲都挡不住）。★ 比较基准必须是**原牌**的属性，不能是上面已被
      // convertTo 改写过的 baseType，否则 ♦ 当火杀会被误当成普通杀挡下。
      const nativeType = SGS.Cards.damageTypeOf(card);
      const effCard = dmgType !== nativeType
        ? Object.assign({}, card, { damageType: dmgType }) : card;

      // ★ 使用【杀】的牌语音：目标已经确定（取消选目标不会走到这里）。
      //   converted（龙胆把【闪】当杀）按「当作的牌」播【杀】；
      //   龙魂 ♦ 当火杀按 convertTo 播【火杀】；丈八 equipConvert 也在这里播。
      //   方天画戟的额外目标复用同一次杀（consumed:true）不重复播。
      if (!opts.consumed || opts.equipConvert) {
        this.playCardVoice(attacker, card,
          converted ? (convertTo || 'sha') : (card.type || 'sha'));
      }
      const actionText = equipConvert
        ? attacker.name + ' 发动【丈八蛇矛】，将两张手牌当【杀】对 ' + target.name + ' 使用'
        : converted
          ? attacker.name + ' 发动【' + (opts.skillName || SGS.skillNameFor(attacker, 'play')) +
            '】，将【' + card.name + '】当【' + convertedName + '】对 ' + target.name + ' 使用'
          : attacker.name + ' 对 ' + target.name + ' 使用【' + displayName + '】';
      if (SGS.log) SGS.log(actionText + (dmg > 1 ? '（【酒】效果，伤害 +1）' : '') +
        (dmgType === 'normal' ? '' : '（' + dmgName + '伤害）') +
        (armorNegated ? '（【青釭剑】无视防具）' : '') + '。', 'sha');
      this.ui.render(this);
      await SGS.sleep(240);

      // ★ 防具锁定技：【仁王盾】挡黑色【杀】；【藤甲】挡「普通【杀】」
      //   （伤害属性 normal，火杀 / 雷杀是属性杀、挡不住）。连【闪】都不用问。
      //   【青釭剑】装备者指定目标后，这个判定整段跳过。
      const armor = (!armorNegated && SGS.Equipment)
        ? SGS.Equipment.blockingArmor(target, effCard) : null;
      if (armor) {
        if (SGS.log) {
          SGS.log('【' + armor.name + '】使 ' + target.name +
            ' 不受这张【' + displayName + '】影响，此【杀】无效。', 'shan');
        }
        this.ui.render(this);
        await SGS.sleep(260);
        return true;
      }

      const res = await this.askShan(target,
        converted ? convertedName : displayName, { armorNegated });
      if (res) {
        const shan = res.card;
        // ★ 八卦阵 / 丈八蛇矛判定成功是「虚拟响应」：没有实体牌，不移除手牌、
        //   不弃置，判定牌本身已在 Judge.run() 里进弃牌堆。
        if (!res.virtual && shan) {
          await this.presentCard(shan, target, { asName: res.viaSkill ? '闪' : null });
          await this.discardConsumed(target, shan);
        }
        const shanText = res.virtual
          ? (res.virtualText || ('发动【' + (res.sourceName || '技能') + '】视为打出【闪】'))
          : res.viaSkill
            ? '发动【' + SGS.skillNameFor(target, 'respond') + '】将【' + shan.name + '】当【闪】打出'
            : '打出【闪】';
        if (SGS.log) SGS.log(target.name + ' ' + shanText + '，抵消了这次【' + displayName + '】。', 'shan');
        this.ui.render(this);
        await SGS.sleep(240);

        // ★【青龙偃月刀】：询问是否继续用一张【杀】（玩家从手牌区选牌）。
        //   追加的杀不占常规出杀次数，会正常再次索要【闪】并结算伤害。
        await this.qinglongFollow(attacker, target, displayName);

        // ★【贯石斧】：杀被【闪】抵消后，可弃置两张牌（手牌 / 装备区），
        //   使这次杀仍然造成伤害。弃牌逐张飞入展示区标「贯石斧弃置」。
        let revived = false;
        if (SGS.Equipment && SGS.Equipment.hasGuanshi(attacker) &&
            SGS.Zones.disposable(attacker).length >= 2) {
          const yes = await this.askOptional(attacker, {
            name: '贯石斧',
            desc: '【贯石斧】：是否弃置两张牌，使这张【' + displayName + '】仍然造成伤害？',
            yes: '发动【贯石斧】', no: '不发动',
            context: 'guanshi', target: target
          });
          if (yes) {
            const entries = await this.pickDisposables(attacker, attacker, 2, {
              name: '贯石斧', type: 'guanshi', useHandPick: true,
              confirmLabel: '弃置（2）', cancelLabel: '不发动',
              hint: '【贯石斧】：从手牌区选牌，也可点左侧装备区选装备，选满两张后点【弃置（2）】。'
            });
            if (entries.length >= 2) {
              for (const e of entries) {
                await this.presentCard(e.card, attacker, {
                  from: e.zone === 'equip' ? 'equip' : undefined,
                  slot: e.zoneKey, dest: 'showcase', note: '贯石斧弃置'
                });
                this.deck.discard(e.card);
                if (e.zone === 'equip' && this.onEquipmentLost) {
                  await this.onEquipmentLost(attacker, e.card);
                }
              }
              revived = true;
              if (SGS.log) {
                SGS.log(attacker.name + ' 发动【贯石斧】，弃置两张牌，' +
                  '这次【' + displayName + '】仍然造成伤害。', 'sha');
              }
              this.ui.render(this);
              await SGS.sleep(220);
            }
          }
        }
        if (revived) {
          await this.damage(target, attacker, dmg,
            dmgType, { armorNegated, sha: true });
        }
      } else {
        if (SGS.log) SGS.log(target.name + ' 没有打出【闪】。', 'warn');

        // ★【寒冰剑】：这次杀将要造成伤害时，若目标「有牌」（手牌 + 装备区，
        //   **不含判定区**），可防止此伤害，改为依次弃置其两张牌（只有一张
        //   就弃一张）。有两张及以上必须弃满两张。
        let prevented = false;
        if (SGS.Equipment && SGS.Equipment.hasHanbing(attacker) &&
            SGS.Zones.hasDisposable(target)) {
          const avail = SGS.Zones.disposable(target).length;
          const n = Math.min(2, avail);
          const yes = await this.askOptional(attacker, {
            name: '寒冰剑',
            desc: '【寒冰剑】：是否防止此伤害，改为依次弃置 ' + target.name +
              ' 的 ' + n + ' 张牌（不含判定区）？',
            yes: '发动【寒冰剑】', no: '不发动',
            context: 'hanbing', target: target
          });
          if (yes) {
            prevented = true;
            if (SGS.log) {
              SGS.log(attacker.name + ' 发动【寒冰剑】，防止了对 ' + target.name +
                ' 的伤害，改为弃置其 ' + n + ' 张牌。', 'sys');
            }
            await this.hanbingDiscard(attacker, target, n);
          }
        }
        if (!prevented) {
          // ★【麒麟弓】：杀将要造成伤害时，可弃置目标装备区里的一张坐骑牌
          if (SGS.Equipment && SGS.Equipment.hasQilin(attacker) &&
              SGS.Equipment.horsesOf(target).length) {
            const yes = await this.askOptional(attacker, {
              name: '麒麟弓',
              desc: '【麒麟弓】：是否弃置 ' + target.name + ' 装备区里的一张坐骑牌？',
              yes: '发动【麒麟弓】', no: '不发动',
              context: 'qilin', target: target
            });
            if (yes) await this.qilinDiscard(attacker, target);
          }
          await this.damage(target, attacker, dmg,
            dmgType, { armorNegated, sha: true });
        }
      }

      // ★【方天画戟】：同一张【杀】对其余目标依次结算（牌已弃、次数已计）
      for (const extra of extraTargets) {
        if (this.over) break;
        await this.useSha(attacker, card, viaSkill, extra,
          { consumed: true, noShaCount: true });
      }

      // 展示区保留到回合结束，由 runTurn 统一清空
      this.ui.render(this);
      return true;
    }

    /**
     * 向被杀方索要【闪】（保持旧接口，内部走通用 askRespond）。
     * reason 可传实际牌名（【火杀】/【雷杀】），让响应提示更准确；
     * 龙胆转化出的杀仍显示「杀」，避免把牌面【闪】写进提示。
     */
    async askShan(target, reason, opts) {
      return this.askRespond(target, 'shan', reason || '杀', opts);
    }

    /**
     * 通用响应：向某角色索要一张 need 类型的牌（'shan' / 'sha'）。
     * reason 是发起响应的牌名（杀 / 万箭齐发 / 南蛮入侵 / 决斗…），用于提示文案。
     * 统一返回 { card, viaSkill } 或 null：
     *   玩家侧可能是裸牌（普通响应）或对象（技能按钮转化），这里做归一化；
     *   AI 侧若用非 need 牌响应，同样视为发动了转化技能。
     * 龙胆等「可以」类技能由 ui.js 的技能按钮按 need 过滤转化方向。
     */
    /**
     * ★ 技能描述里写「牌」时的统一素材范围：手牌 + 装备区（不含判定区）。
     *   之前 brink / 无懈 / 青龙追加杀等分支仍按 hand.some 判断，导致
     *   「手牌用完了但装备区还有一张 ♥ 牌可当【桃】」时提前判死 / 拒绝转化。
     *   这里集中收口，所有转化校验都走同一处，避免再漏。
     */
    conversionCardPool(player) {
      if (!player) return [];
      if (SGS.Zones && typeof SGS.Zones.conversionCards === 'function') {
        return SGS.Zones.conversionCards(player).map((e) => e.card);
      }
      return (player.hand || []).slice();
    }

    /** 按 id 找一张「牌」（手牌 / 装备区），返回 SGS.Zones 条目 */
    conversionCardEntry(player, id) {
      if (!player) return null;
      if (SGS.Zones && typeof SGS.Zones.findConversionCard === 'function') {
        return SGS.Zones.findConversionCard(player, id);
      }
      const c = (player.hand || []).find((x) => String(x.id) === String(id));
      return c ? { id: c.id, card: c, zone: 'hand', zoneKey: 'hand' } : null;
    }

    /**
     * ──【无懈可击】响应链 ──────────────────────────────────
     * 一次锦囊结算共用一个 ctx：negated 记录被抵消的「目标效果」，
     * optOut 记录选择「本轮不使用无懈可击」的玩家（整张牌结算期间都不再问）。
     */
    createWuXieCtx(card, user, targetCount) {
      const type = card && card.type;
      const delayed = !!(SGS.Cards && SGS.Cards.isDelayed &&
        SGS.Cards.isDelayed(type));
      // ★「逐目标结算」的群体锦囊：第一轮**不跳过使用者本人**。
      //   这类牌对「每一个目标」都是一次独立的无懈结算，使用者完全可以
      //   无懈这张牌【对其他目标】的效果（A 用桃园结义，仍可无懈 B 的回血）。
      //   只有「非延时、单体普通锦囊」才在第一轮跳过使用者，避免自己
      //   无懈自己刚使用的锦囊。延时锦囊（判定阶段）保持原有行为。
      //   万箭 / 南蛮 / 桃园 / 五谷是逐目标询问无懈。
      //   ★ 铁索连环按用户口径归到单体侧：只要是自己使用的，第一轮就不
      //     询问自己（和过河拆桥 / 借刀杀人一样）；其他角色仍照常询问，
      //     别人打出无懈后自己仍可反无懈。
      const perTargetTrick = type === 'wanjian' || type === 'nanman' ||
        type === 'taoyuan' || type === 'wugufengdeng';
      const selfAskAllowed = delayed || perTargetTrick;
      // ★ 五谷丰登 / 桃园结义：这两张牌对【当前结算目标】是纯收益
      //   （选牌 / 回血），受益者没理由主动无懈自己，所以第一轮询问圈里
      //   跳过【当前目标本人】；但整条链照常跑，其他所有角色（含使用者）
      //   仍可无懈该目标的效果 —— 这正是「对方开五谷、对方先选牌时也要
      //   问我是否无懈」的关键，旧版把整条链直接跳过，顺序就反了。
      //   别人打出无懈后，目标本人仍可参与反无懈（只在第一轮跳过）。
      //   ★ 南蛮 / 万箭对目标有害，不跳过目标自己：别人开的 AOE 结算到
      //     我头上时我也要被问；自己开的 AOE 本来结算不到我，其余每个
      //     目标结算时都照常问我。
      const skipBeneficiary = !delayed &&
        (type === 'wugufengdeng' || type === 'taoyuan');
      return {
        card: card, user: user,
        // 目标数 >= 2 的锦囊才会多次询问，才提供「本轮不使用」快捷按钮。
        multiTarget: (targetCount || 0) >= 2,
        selfAskAllowed: selfAskAllowed,
        skipBeneficiary: skipBeneficiary,
        negated: new Set(), optOut: new Set()
      };
    }

    /** 这个目标身上的效果是否已被无懈可击抵消 */
    isEffectNegated(ctx, target) {
      return !!(ctx && target && ctx.negated.has(target));
    }

    /** 从 startPlayer 起按 players 数组（逆时针座次）列出所有存活角色 */
    wuXieOrder(startPlayer) {
      const n = this.players.length;
      const i = this.players.indexOf(startPlayer);
      if (i < 0) return this.players.slice();
      return this.players.slice(i, n).concat(this.players.slice(0, i));
    }

    /**
     * 询问一圈是否有人对「当前这张牌」使用无懈可击。
     * 返回第一个使用的人；若有人选择「本轮不使用」，本张牌结算期间跳过他。
     */
    async askWuXieRound(ctx, startPlayer, target, againstPlayer, meta) {
      meta = meta || {};
      for (const p of this.wuXieOrder(startPlayer || ctx.user)) {
        if (this.over) return null;
        if (!p || p.isDead() || ctx.optOut.has(p)) continue;
        // ★ 第一张无懈：使用者本人不再被问「是否无懈自己使用的普通锦囊」
        //   （万箭齐发 / 南蛮入侵 / 延时锦囊例外，依旧询问）。
        //   只在第一轮跳过；B 打出无懈后 A 仍可反无懈（见需求 2）。
        if (meta.skipUser && p === ctx.user) continue;
        // ★ 五谷 / 桃园：第一轮跳过「当前结算目标本人」（对自己有利，
        //   不会主动无懈自己的收益）；整条链不跳过，其他角色照常可无懈。
        //   别人打出无懈后目标本人仍能反无懈（skipBeneficiary 只在第一轮）。
        if (meta.skipBeneficiary && p === target) continue;
        // ★ 无懈打无懈：刚打出上一张【无懈可击】的人本轮不再被问，
        //   否则会出现「自己抵消自己刚打出的无懈」。
        if (meta.lastWuXie && p === meta.lastWuXie) continue;
        // ★【龙魂】♠ 当【无懈可击】：手里没有真无懈但有可转化的 ♠ 牌时，
        //   同样要进入询问（玩家点技能按钮 / AI 自动选转化牌）。
        // ★「牌」= 手牌 + 装备区：装备区里的 ♠ / 黑牌也可经【龙魂】/
        //   【看破】当【无懈可击】，不能因为手里没有牌就整轮跳过。
        const pool = this.conversionCardPool(p);
        if (!pool.some((c) =>
          c.type === 'wuxiekeji' ||
          (typeof p.canUseAsType === 'function' && p.canUseAsType(c, 'wuxiekeji')))) continue;
        const used = await this.askWuXieOnce(ctx, p, target, againstPlayer, meta);
        if (used) return used;
      }
      return null;
    }

    /** 询问单个角色；玩家走 ui.waitWuXie，AI 走 ai.askWuXie */
    async askWuXieOnce(ctx, player, target, againstPlayer, meta) {
      meta = meta || {};
      const opts = {
        card: ctx.card, target: target, source: againstPlayer,
        user: ctx.user,
        // 嵌套链提示用：上一张无懈是谁打的、当前「若不抵消」原锦囊的结局
        lastWuXie: meta.lastWuXie || null,
        negated: !!meta.negated,
        multiTarget: !!ctx.multiTarget
      };
      let choice = null;
      if (SGS.isDecider(player)) {
        if (this.ui && typeof this.ui.waitWuXie === 'function') {
          choice = await this.ui.waitWuXie(player, this, opts);
        }
      } else if (this.ai && typeof this.ai.askWuXie === 'function') {
        choice = await this.ai.askWuXie(player, opts);
      }
      if (choice === 'optOut') {
        ctx.optOut.add(player);
        if (SGS.log) SGS.log(player.name + ' 选择本轮不再使用【无懈可击】。', 'sys');
        return null;
      }
      if (!choice) return null;
      let card = null;
      let asName = null;
      let skillName = null;
      if (choice.viaSkill) {
        // 技能按钮 / AI 回传的转化对象：{ card, viaSkill:true, conversion, scene:'wuxie' }
        const conv = choice.conversion;
        card = choice.card;
        if (!card || !conv ||
            (conv.scenes || []).indexOf('wuxie') < 0 ||
            !SGS.Cards.matchesFrom(card, conv.from) ||
            typeof player.canUseAsType !== 'function' ||
            !player.canUseAsType(card, 'wuxiekeji')) return null;
        asName = '无懈可击';
        // ★ 按场景取真实发动的技能名：诸葛亮是【看破】，不是主技能【火计】
        skillName = SGS.skillNameFor(player, 'wuxie') || player.skill.name;
      } else {
        // 真【无懈可击】理论上只在手牌，但仍用统一「牌」范围兜底，
        // 避免未来装备区放响应牌时被误拒。
        const rawId = (typeof choice === 'object') ? choice.id : choice;
        const entry = this.conversionCardEntry(player, rawId);
        card = entry ? entry.card : (typeof choice === 'object' ? choice : null);
        if (!card || card.type !== 'wuxiekeji') return null;
      }
      // ★ 最终复核同样按「牌」范围，转化素材可以来自装备区。
      const still = this.conversionCardEntry(player, card.id);
      if (!still) return null;
      card = still.card || card;
      return {
        player: player, card: card,
        asName: asName, skillName: skillName
      };
    }

    /**
     * 对某一目标的效果进行无懈响应，含「无懈打无懈」的嵌套链：
     * 每有人使用一张【无懈可击】，就从该使用者起重新询问一圈，
     * 够不成新一轮则结束；无懈总数为奇数时该目标效果被抵消。
     */
    async askWuXie(ctx, target, startPlayer) {
      if (!ctx || !target || ctx.negated.has(target)) return true;
      let negated = false;
      let start = startPlayer || ctx.user;
      let lastWuXie = null;   // 上一张【无懈可击】的使用者（null = 第一轮）
      let guard = 0;
      while (guard++ < 40 && !this.over) {
        const meta = {
          // 只对「第一张无懈」跳过使用者本人；B 用无懈后 A 仍可被问反无懈。
          skipUser: lastWuXie === null && !ctx.selfAskAllowed,
          // ★ 五谷 / 桃园：只在第一轮跳过「当前结算目标本人」，整条链照跑。
          //   对方开五谷、对方先选牌时，我仍会被问是否无懈他；轮到我选牌时
          //   我不被问（对自己有利）。别人无懈我的收益后，我仍可反无懈。
          skipBeneficiary: lastWuXie === null && !!ctx.skipBeneficiary,
          lastWuXie: lastWuXie,
          // 本轮若无人再出无懈，最初锦囊的最终状态（生效 / 失效）
          negated: negated
        };
        const used = await this.askWuXieRound(ctx, start, target, start, meta);
        if (!used) break;
        // ★ 使用（或转化使用）【无懈可击】的牌语音。与角色技能语音是两条
        //   独立链路：看破/龙魂播技能音，这里播牌音，不是重复触发。
        this.playCardVoice(used.player, used.card, 'wuxiekeji');
        // ★ 展示区小字：转化出的【无懈可击】只留一个「当作【无懈可击】」，
        //   真牌仍标「无懈可击」；不再同时叠两个 .as-label 造成重叠。
        await this.presentCard(used.card, used.player, {
          dest: 'showcase',
          note: used.asName ? null : '无懈可击',
          asName: used.asName || null
        });
        await this.discardConsumed(used.player, used.card);
        negated = !negated;
        start = used.player;   // 无懈打无懈：从刚使用无懈的人起重新问一圈
        lastWuXie = used.player;
        if (SGS.log) {
          const head = used.skillName
            ? used.player.name + ' 发动【' + used.skillName + '】，将【' +
              used.card.name + '】当【无懈可击】使用'
            : used.player.name + ' 使用【无懈可击】';
          SGS.log(head +
            (negated ? '，抵消了对 ' + target.name + ' 的效果' : '，抵消了上一张【无懈可击】') +
            '。', 'trick');
        }
        this.ui.render(this);
        await SGS.sleep(260);
        // ★【看破】：诸葛亮的【无懈可击】不可被响应 —— 直接结束
        //   「无懈打无懈」链（只影响无懈，不是全场禁响应）。
        const unrespondable = used.player && used.player.skill &&
          ((typeof used.player.hook === 'function' && used.player.hook('wuXieUnrespondable')) ||
           used.player.skill.wuXieUnrespondable === true);
        if (unrespondable) {
          // ★ 技能名按场景取（诸葛亮 wuxie →【看破】）。
          //   转化无懈时上面那条日志已写「发动【看破】」，日志兜底已经播过
          //   大字 + 语音，这里绝不再播一次，否则同一技能会出两条音频；
          //   用【真·无懈可击】时没有这类日志，仍需显式播一次。
          const wuxieSkill = SGS.skillNameFor(used.player, 'wuxie') || '看破';
          if (!used.skillName) this.announceSkill(used.player, wuxieSkill);
          if (SGS.log) SGS.log('【' + wuxieSkill + '】使这张【无懈可击】不可再被响应。', 'sys');
          break;
        }
      }
      if (guard >= 40 && SGS.log) {
        SGS.log('【无懈可击】响应次数已达上限，结束响应链。', 'warn');
      }
      if (negated) ctx.negated.add(target);
      return negated;
    }

    /**
     * 「可以」类装备技能的统一询问入口。
     * 玩家侧 → ui.waitOptional()（操作区两个按钮）；AI 侧 → ai.askOptional()。
     * 无界面的自测假 UI 默认「不发动」，保证既有确定性用例不受影响。
     * @returns {Promise<boolean>} 是否发动
     */
    async askOptional(player, opts) {
      opts = opts || {};
      if (SGS.isDecider(player)) {
        if (this.ui && typeof this.ui.waitOptional === 'function') {
          return !!(await this.ui.waitOptional(player, this, opts));
        }
        return false;
      }
      if (this.ai && typeof this.ai.askOptional === 'function') {
        return !!(await this.ai.askOptional(player, opts));
      }
      return true;
    }

    /**
     * 通用二选一询问：玩家走 ui.waitChoice（操作区按钮），AI 走 ai.askChoice。
     * 无界面兜底取第一项。返回所选选项的 value。
     */
    async askChoice(player, opts) {
      opts = opts || {};
      if (SGS.isDecider(player)) {
        if (this.ui && typeof this.ui.waitChoice === 'function') {
          return await this.ui.waitChoice(player, this, opts);
        }
      } else if (this.ai && typeof this.ai.askChoice === 'function') {
        return await this.ai.askChoice(player, opts);
      }
      // 无界面兜底也只看可用项（【渐营】置灰的技能不该被自动选中）
      const usable = (opts.choices || []).filter((c) => !c.disabled);
      return (usable[0] && usable[0].value) || null;
    }

    /**
     * 响应【闪】/【杀】：内部完成后按「打出的牌」播牌语音。
     * 虚拟响应（八卦阵判定、丈八蛇矛两张牌当杀）没有单张实体牌，跳过；
     * 丈八由 zhangbaRespond() 自己补一张【杀】。
     */
    async askRespond(target, need, reason, opts) {
      // ★ 有些专项自测会把本方法单独 call 到普通对象上（没有原型链），
      //   所以内部实现与播报都显式走 SGS.Game.prototype，保证这类用法照常工作。
      const res = await SGS.Game.prototype._askRespondInner.call(
        this, target, need, reason, opts);
      if (res && !res.virtual && res.card) {
        const asType = res.conversion
          ? (res.conversion.asType || res.conversion.to)
          : (res.viaSkill ? (need || 'shan')
             : (res.card.type || need || 'shan'));
        SGS.Game.prototype.playCardVoice.call(this, target, res.card, asType);
      }
      return res;
    }

    async _askRespondInner(target, need, reason, opts) {
      need = need || 'shan';
      opts = opts || {};
      const armorNegated = !!opts.armorNegated;   // 【青釭剑】

      // ★【八卦阵】：需要【闪】时可以先判定（「可以」类，先询问）。
      //   判定红色 → 视为打出一张【闪】，返回一个不带实体牌的「虚拟响应」，
      //   下游不会去移除手牌 / 弃牌；判定黑色 → 标记失效后继续正常选【闪】
      //   （与原版一致：判定不中仍可以自己出闪）。
      //   判定流程（亮出 → 改判预留 → 生效/失效动画 → 弃置）全在 judge.js。
      //   ★【青釭剑】无视防具 → 这次杀里八卦阵也不能发动。
      if (need === 'shan' && !armorNegated &&
          SGS.Equipment && SGS.Equipment.armorFlag(target, 'bagua')) {
        // ★【八阵】发动点：诸葛亮装备区没有防具、需要用【闪】、且使用
        //   虚拟【八卦阵】进行判定时。armorCard() 的 virtual 标记正好区分
        //   「八阵虚拟防具」与「真装备的八卦阵」：
        //     · 装了任意真防具 → 八阵不生效（有 bagua 标记时也是真八卦阵）
        //     · 【青釭剑】armorNegated → 整个分支不进入，八阵同样不发动
        //   判定红 / 黑都算「使用八卦阵」，所以只要选了发动就播一次。
        const ac = SGS.Equipment.armorCard
          ? SGS.Equipment.armorCard(target) : null;
        const isBaZhen = !!(ac && ac.virtual);
        const yes = await this.askOptional(target, {
          name: '八卦阵',
          desc: '【八卦阵】：是否进行一次判定？结果为红色则视为你打出了一张【闪】。',
          yes: '发动【八卦阵】', no: '不发动',
          context: 'bagua'
        });
        if (yes && SGS.Judge) {
          if (isBaZhen) {
            // 显式播【八阵】大字 + 语音（ui.log 的日志兜底在假界面下可能不生效）。
            // 下面相关日志刻意不写「发动【八阵】」，避免日志兜底再播一次横幅。
            this.announceSkill(target, '八阵');
            if (SGS.log) {
              SGS.log(target.name + '【八阵】视为装备【八卦阵】，进行一次判定。', 'shan');
            }
          }
          const jr = await SGS.Judge.run(this, target, {
            reason: '八卦阵',
            isEffective: (c) => SGS.Judge.isRed(c)
          });
          if (jr && jr.effective) {
            if (isBaZhen) {
              if (SGS.log) {
                SGS.log(target.name + '【八阵】判定为红色，视为打出一张【闪】。', 'shan');
              }
            } else if (SGS.log) {
              SGS.log(target.name + ' 发动【八卦阵】判定为红色，视为打出一张【闪】。', 'shan');
            }
            return {
              card: null, viaSkill: true, virtual: true,
              sourceName: isBaZhen ? '八阵' : '八卦阵', judge: jr,
              virtualText: isBaZhen
                ? '【八阵】判定为红色，视为打出【闪】'
                : '发动【八卦阵】判定为红色，视为打出【闪】'
            };
          }
        }
      }

      if (SGS.isDecider(target)) {
        const res = await this.ui.waitRespond(target, this, {
          need: need, reason: reason || '杀', armorNegated: armorNegated
        });
        if (!res) return null;
        // ★【丈八蛇矛】响应需要【杀】的牌（南蛮入侵 / 决斗）：
        //   玩家点武器栏选了两张手牌 → 在这里移手 / 弃置并返回虚拟响应。
        if (res.zhangba && need === 'sha') {
          return await this.zhangbaRespond(target, res.cards);
        }
        return res.card
          ? {
            card: res.card, viaSkill: !!res.viaSkill,
            conversion: res.conversion || null
          }
          : { card: res, viaSkill: false };
      }
      const answer = await this.ai.respondNeed(target, need);
      await SGS.sleep(260); // 给 AI 一点「思考」节奏
      // ★ AI 侧也可以用【丈八蛇矛】把两张手牌当【杀】打出
      if (answer && answer.zhangba && need === 'sha') {
        return await this.zhangbaRespond(target, answer.cards);
      }
      // ★ 用 matchesRespond 判定：火杀 / 雷杀直接响应 need='sha' 不是技能转化，
      //   否则会被误写成「发动【咆哮】将【火杀】当【杀】打出」。
      return answer
        ? { card: answer, viaSkill: !SGS.Cards.matchesRespond(answer, need) }
        : null;
    }

    /**
     * 扣体力并播放受击动画（角色框抖动 + 红闪），然后处理濒死 / 阵亡。
     * @param {number} amount 伤害点数（【酒】加成的【杀】为 2）
     * @param {object} source 伤害来源，阵亡时作为胜者
     * @param {string} dmgType 'normal' | 'fire' | 'thunder'（缺省普通，旧调用不变）
     *
     * ★【藤甲】：受到火焰伤害时该伤害 +1。加伤统一放在这里，因此将来
     *   任何火焰伤害来源（火杀 / 火攻等）都会自动带上，不需要各处重复判断。
     * ★【白银狮子】：最终伤害大于 1 点时减至 1 点。放在加伤之后结算，
     *   因此「酒杀 / 火杀打藤甲」这类大伤害也会被正确压到 1 点。
     * ★ opts.armorNegated（【青釭剑】）：这次伤害无视目标防具，
     *   藤甲火焰加伤与白银狮子减伤都不生效。
     * ★【铁索连环】：属性伤害（火 / 雷）落在连环状态角色身上时，会依次
     *   传导给其他连环角色（同来源、同程度、同属性），并重置所有受伤害者；
     *   opts.noChain = 传导出来的伤害不再二次传导，opts.chainFixed = 伤害点数
     *   已经固定，不再因目标自己的藤甲再次 +1。opts.sha = 这是【杀】的伤害，
     *   才参与「造成伤害时」【古锭刀】加伤（绝情转体力流失时不参与）。
     */
    async damage(target, source, amount, dmgType, opts) {
      amount = amount || 1;
      dmgType = dmgType || 'normal';
      opts = opts || {};
      const armorNegated = !!opts.armorNegated;
      // ★【绝情】：来源技能把「即将造成的伤害」改为失去体力 —— 不吃藤甲 / 白银狮子，
      //   不触发「受到伤害后」钩子，也不做属性伤害的连环传导；伤害音效、
      //   受击特效、濒死 / 阵亡结算完全照常。
      const asLoss = !!(source && typeof source.hook === 'function' &&
        source.hook('damageAsLoss', target, amount, dmgType, opts));
      // ★【古锭刀】：锁定技，【杀】「造成伤害时」目标无手牌则伤害 +1。
      //   绝情把整次伤害改为失去体力，不存在「造成伤害」这个时点，因此吃不到；
      //   所以必须放在 asLoss 判定之后（和藤甲加伤同一层），不能在 useSha 里预处理。
      //   shaDamageAmount(..., 0) 的返回值即加成点数（0 或 1），日志也在这里写。
      const gudingBonus = (!asLoss && opts.sha && !opts.chainFixed && source &&
        typeof this.shaDamageAmount === 'function')
        ? this.shaDamageAmount(source, target, 0) : 0;
      // ★ 传导伤害「同程度」：沿用上游已经算好的点数，不再叠加藤甲加伤
      const fireBonus = (!asLoss && !armorNegated && !opts.chainFixed &&
        dmgType === 'fire' && SGS.Equipment)
        ? SGS.Equipment.fireDamageBonus(target) : 0;
      const before = amount + fireBonus + gudingBonus;
      const cap = (asLoss || armorNegated || !SGS.Equipment)
        ? Infinity : SGS.Equipment.damageCap(target);
      const total = before > cap ? cap : before;
      const capped = before > cap;
      target.hp -= total;
      // ★ 作用音效：按最终实际点数（已含藤甲加伤 / 白银狮子减伤）与来源选文件。
      //   与受击抖动动画同帧开始，不参与规则结算。
      //   将来「角色技能对自己造成伤害」（source === target）且调用方没显式
      //   指定来源时，自动走 08【自残】；目前没有任何此类技能，纯预留。
      const soundOpts = (opts.sound || source !== target)
        ? opts : Object.assign({}, opts, { sound: 'self' });
      this.playDamageSound(dmgType, total, soundOpts);
      if (SGS.log) {
        const dmgName = dmgType === 'fire' ? '火焰' : dmgType === 'thunder' ? '雷电' : '';
        let txt = asLoss
          ? target.name + ' 失去 ' + total + ' 点体力（【绝情】：伤害视为失去体力）'
          : target.name + ' 受到 ' + total + ' 点' + dmgName + '伤害';
        if (fireBonus) txt += '（【藤甲】火焰伤害 +1）';
        if (capped) txt += '（【白银狮子】将 ' + before + ' 点伤害减至 ' + total + ' 点）';
        SGS.log(txt + '，体力 ' + Math.max(0, target.hp) + '/' + target.maxHp + '。', 'dmg');
      }
      // ★ 受击动画：角色框抖动（.hit 类）+ 伤害数值飘字 + 属性特效。
      //   传的是【最终实际点数】total（已含藤甲加伤 / 白银狮子减伤），
      //   与受击音效同源；旧版只传 target 的假界面仍照常工作。
      if (this.ui && typeof this.ui.shakeHero === 'function') {
        this.ui.shakeHero(target, total, dmgType);
      }
      // ★【伤逝】复查「手牌数 < X」：扣血当刻 X 变大，可能让手牌数跌破 X。
      //   ★ 这是「进入濒死之前」的最后窗口：即使体力已经被打到 0 / 负数，
      //     也在这里（direct，非 deferred）询问 / 摸牌，问完再往下走 brink()。
      //     所以 1 血 2 牌受 1 点伤害 → 先摸到 3 张，再进入濒死自救。
      await this.checkHandBelowX(target, { direct: true });

      this.ui.render(this);
      await SGS.sleep(320);

      // ★【矢北】等「受到伤害后」技能：本回合第 1 次回 1 血，此后每次失去 1 血。
      //   绝情把伤害改成失去体力，因此不进入这里（不算「受到伤害」）。
      if (!asLoss) {
        target.turnDamageCount = (target.turnDamageCount || 0) + 1;
        const dmgHook = target.skill && target.skill.onDamaged;
        if (typeof dmgHook === 'function') {
          await dmgHook(this, target, target.turnDamageCount,
            { amount: total, source: source, dmgType: dmgType });
        }
      }
      if (target.hp <= 0) await this.brink(target);
      if (target.hp <= 0 && !this.over) {
        await this.onDeath(target);
        if (this.teamMode) {
          // ★ 2v2：只有「一个阵营全灭」才结束对局，个别角色阵亡继续打
          if (this.wipedTeam()) this.gameOver(source);
        } else {
          this.gameOver(source);
        }
      }

      // ★【铁索连环】属性伤害传导（2026-11 规则修正）：
      //   ① 先把这个直接命中的目标「整套」结算完（伤害 → 濒死 → 阵亡 →
      //      胜负），也就是本方法走到这里时首目标已经全部处理完毕；
      //   ② 再从**当前回合角色**开始按逆时针挨个检测全场：
      //      处于连环状态的角色依次吃同来源 / 同程度 / 同属性的传导伤害，
      //      每个人都完整结算（含濒死 / 阵亡）之后才轮到下一个人；
      //   ③ 传导伤害不再二次传导（noChain）。
      const elemental = !asLoss && (dmgType === 'fire' || dmgType === 'thunder');
      if (elemental && target.chained && !opts.noChain && this.players) {
        target.chained = false;
        const origin = (this.actor && this.actor.dead) ? target : (this.actor || target);
        const order = this.turnOrderFrom(origin, true);
        const spread = order.filter((p) => p && p !== target && p.chained && !p.dead);
        if (spread.length && SGS.log) {
          SGS.log('【铁索连环】' + target.name + ' 的' +
            (dmgType === 'fire' ? '火焰' : '雷电') + '伤害开始传导，自 ' +
            origin.name + ' 起按逆时针依次传导给 ' +
            spread.map((p) => p.name).join('、') + '。', 'dmg');
        }
        // ★ 传导伤害的来源：发起者若已经在首目标结算中阵亡，改为无来源伤害
        const chainSource = (source && source.dead) ? null : source;
        for (const p of spread) {
          if (!p.chained || p.dead) continue;
          p.chained = false;
          if (SGS.log) {
            SGS.log('【铁索连环】传导至 ' + p.name + '，' + p.name + ' 解除连环状态。', 'dmg');
          }
          this.ui.render(this);
          await this.damage(p, chainSource, total, dmgType, {
            noChain: true, chainFixed: true,
            sound: opts.sound    // 火攻 / 闪电的固定音效随传导沿用
          });
          if (this.over) return;
        }
      }
    }

    /**
     * ★ 从某名角色开始、按逆时针（players 数组顺序）的座位序列。
     *   includeSelf=false 时从「下家」开始（万箭齐发 / 南蛮入侵等由使用者
     *   下家起的群体效果）；true 则包含本人（桃园结义 / 五谷丰登 / 铁索传导）。
     */
    turnOrderFrom(start, includeSelf) {
      const n = (this.players || []).length;
      if (!n) return [];
      let i = (start && this.players.indexOf(start) >= 0)
        ? this.players.indexOf(start) : 0;
      if (!includeSelf) i = (i + 1) % n;
      const out = [];
      for (let k = 0; k < n; k++) out.push(this.players[(i + k) % n]);
      return out;
    }

    /**
     * 濒死：可连续使用手里的真【桃】/【酒】自救；技能描述写「牌」的
     * 转化（【龙魂】♥ 当【桃】）同样可用装备区素材，每张回复 1 点体力，
     * 直到体力回到 1 点以上、没有自救牌、或玩家放弃。
     * 【酒】在濒死时**次数不限**（不受出牌阶段「每回合限一次」约束），
     * 且只作回复用，不置 jiuBuff 伤害加成。
     * 伤害可能超过 1 点（酒杀），因此这里必须循环而非一次回到 1 点。
     *
     * ★【绝境】锁定技：进入濒死（本方法被调用）与脱离濒死（hp 回到 1 点
     *   以上）各摸一张牌，触发逻辑内聚在角色文件的 onBrinkState 钩子里。
     *   摸牌发生在循环之前 / 之后，摸到的【桃】【酒】或 ♥ 牌可以立刻继续
     *   用于本次自救（每轮都会重算可用牌）。
     * ★【龙魂】♥ 当【桃】：玩家点技能按钮回传的转化对象在这里归一化，
     *   与真正的【桃】一样回复 1 点体力；牌仍按原花色进弃牌堆。
     */
    /**
     * ★「其他角色进入濒死状态时」的救援钩子（【仁心】这类）。
     *   濒死结算开始时先逐个询问其他角色；有人救起（hp > 0）就立即返回。
     *   · 用 player.dead（阵亡标记）判断已死，不能用 isDead()——它等价于
     *     hp <= 0，濒死角色本身就会命中。
     *   · 每名角色每次濒死只问一次；不发动就继续问下一位。
     */
    async askBrinkRescue(target) {
      if (!target || target.hp > 0 || !this.players) return;
      for (const p of this.players) {
        if (target.hp > 0 || this.over) return;
        if (!p || p === target || p.dead) continue;
        const hook = p.skill && p.skill.onOtherBrink;
        if (typeof hook !== 'function') continue;
        try {
          await hook(this, p, target);
        } catch (e) {
          if (typeof console !== 'undefined' && console.warn) {
            try { console.warn('[brink] 濒死救援钩子异常', e); } catch (e2) { /* 忽略 */ }
          }
        }
      }
    }

    async brink(target) {
      if (SGS.log) SGS.log(target.name + ' 濒死！', 'dmg');
      // ★ 先问其他角色（【仁心】等）：救起来就不必进入自救循环。
      await this.askBrinkRescue(target);
      const passive = (target.skill && typeof target.skill.onBrinkState === 'function')
        ? target.skill.onBrinkState : null;
      if (passive) await passive(this, target, 'enter');

      let guard = 0;
      while (target.hp <= 0 && guard++ < 16) {
        const saves = target.hand.filter((c) => c.type === 'tao' || c.type === 'jiu');
        // ★ 没有真桃 / 酒时，若还有可当【桃】的转化牌（♥）仍要给一次
        //   自救机会。★「牌」包括手牌 + 装备区：神赵云 1 血中闪电时，
        //   手牌 ♥ 用完后装备区还有 ♥，旧版只扫 target.hand 就提前 break，
        //   直接判死；这正是本次修复的 bug。
        const conversionPool = this.conversionCardPool(target);
        const canConvert = conversionPool.some(
          (c) => c.type !== 'tao' &&
            typeof target.canUseAsType === 'function' &&
            target.canUseAsType(c, 'tao')
        );
        // ★【涅槃】：即便手里一张桃/酒都没有，只要限定技还没用过，
        //   仍要在濒死界面给一次发动机会（右下技能按钮 / AI 决策）。
        const canAct = SGS.availableSkillActions(target, 'brink').length > 0;
        if (!saves.length && !canConvert && !canAct) break;

        let used = null;
        if (SGS.isDecider(target)) {
          used = await this.ui.waitBrink(target, saves, this);
        } else {
          used = await this.ai.brink(target);
        }
        if (!used) break; // 放弃 / 脏数据
        // 一次性主动技：发动后体力通常已回到 3，循环条件自然结束。
        if (used.type === 'skillAction') {
          await this.useSkillAction(target, used.name, used.scene || 'brink');
          continue;
        }

        let card = used;
        let asName = null;
        let skillName = null;
        if (used.viaSkill) {
          // 技能按钮转化：{ card, viaSkill:true, conversion, scene:'brink' }
          const conv = used.conversion;
          card = used.card;
          if (!card || !conv ||
              (conv.scenes || []).indexOf('brink') < 0 ||
              !SGS.Cards.matchesFrom(card, conv.from) ||
              !target.canUseAsType(card, 'tao') ||
              !this.conversionCardEntry(target, card.id)) break;
          asName = '桃';
          skillName = SGS.skillNameFor(target, 'brink') || target.skill.name;
        } else if (card.type !== 'tao' && card.type !== 'jiu') {
          break; // 放弃 / 脏数据
        }
        const stillThere = this.conversionCardEntry(target, card.id);
        if (!stillThere) break;
        card = stillThere.card || card;

        // 濒死使用【酒】自救播酒音；转化当【桃】统一按 tao 处理（无素材，静默）
        this.playCardVoice(target, card, asName ? 'tao' : card.type);
        await this.presentCard(card, target, { dest: 'showcase', asName: asName });
        await this.discardConsumed(target, card);
        this.healPlayer(target, 1);
        if (SGS.log) {
          const head = skillName
            ? target.name + ' 发动【' + skillName + '】，将【' + card.name + '】当【桃】自救'
            : target.name + ' 使用【' + card.name + '】自救';
          SGS.log(head + '，体力恢复至 ' +
            Math.max(0, target.hp) + '/' + target.maxHp + '。', 'heal');
        }
        this.ui.render(this);
        await SGS.sleep(300);
      }

      // ★ 自救失败 → 向其他角色求【桃】（顺序同桃园结义：当前回合角色起
      //   逆时针）。2v2 里队友会救；1v1 只有一个对手，没有求桃的必要，
      //   因此不做弹窗打扰（原本的自救流程完全不变）。
      if (target.hp <= 0 && !this.over) await this.askOthersForTao(target);

      // 脱离濒死才摸第二张；没救回来（随后阵亡）只触发了「进入」那一次
      if (target.hp > 0 && passive) await passive(this, target, 'leave');
    }

    /**
     * ★ 濒死「可当【桃】使用」的牌：真【桃】直接算；转化的牌必须同时满足
     *   · canUseAsType(card, 'tao') 通过；
     *   · 该技能的转化项明确声明了 brink 场景（如【龙魂】♥ 当【桃】），
     *     避免把「只能在出牌阶段当桃」的技能误用到救援上。
     * @returns {null|{card, asName, skillName}}
     */
    rescueTaoOf(player, card) {
      if (!player || !card) return null;
      if (card.type === 'tao') return { card: card, asName: null, skillName: null };
      if (typeof player.canUseAsType !== 'function' ||
          !player.canUseAsType(card, 'tao')) return null;
      const convs = (player.skill && player.skill.conversions) || [];
      const conv = convs.find((c) => c && c.to === 'tao' &&
        (c.scenes || ['play']).indexOf('brink') >= 0 &&
        (!SGS.Cards.matchesFrom || SGS.Cards.matchesFrom(card, c.from)));
      if (!conv) return null;
      return {
        card: card,
        asName: '桃',
        skillName: conv.skill || (player.skill && player.skill.name) || '技能'
      };
    }

    /**
     * ★ 濒死求桃：濒死角色自救失败后，从当前回合角色起按逆时针依次询问
     *   其他角色是否对其使用【桃】；每张回复 1 点，脱离濒死即停止。
     *   · 只问同阵营角色（2v2 队友）与「愿意救」的一方 —— 敌人不会救，
     *     1v1 也没有队友，因此单挑流程与以前完全一致（不弹无意义的窗）。
     *   · 真人走 ui.waitPick（点一张【桃】→【使用桃】/【不救】），
     *     AI 走 ai.saveBrink。
     */
    async askOthersForTao(target) {
      if (!target || target.hp > 0 || this.over) return;
      if (!this.players || this.players.length <= 2) return;
      const order = this.turnOrderFrom(this.actor || target, true)
        .filter((p) => p && p !== target && !p.dead && !p.isDead());
      if (SGS.log) SGS.log('向其他角色求【桃】（自 ' +
        ((this.actor && this.actor.name) || target.name) + ' 起逆时针）。', 'sys');
      let guard = 0;
      while (target.hp <= 0 && !this.over && guard++ < 3) {
        let acted = false;
        for (const p of order) {
          if (target.hp > 0 || this.over) return;
          if (!p || p.dead || p.isDead()) continue;
          if (!this.isTeammate(p, target)) continue;      // 敌人不救
          // ★ 候选 = 真【桃】+ 转化当【桃】的牌（【龙魂】♥ 当【桃】）。
          //   「转化的桃就是桃」：救援时一律按【桃】结算，回 1 点体力。
          const pool = this.conversionCardPool(p);
          const usable = pool.some((c) => !!this.rescueTaoOf(p, c));
          if (!usable) continue;

          let card = null;
          if (SGS.isDecider(p) && this.ui && typeof this.ui.waitPick === 'function') {
            const id = await this.ui.waitPick(p, this, {
              hint: '【濒死求桃】' + target.name + ' 濒死，可用【桃】或转化当【桃】的牌救他。',
              confirmLabel: '使用桃', cancelLabel: '不救',
              allowEquip: true,
              filter: (c) => !!this.rescueTaoOf(p, c),
              rejectHint: '只能用【桃】（或技能转化当【桃】的牌）救援。'
            });
            if (id) {
              const entry = this.conversionCardEntry(p, id);
              card = entry ? entry.card : null;
            }
          } else if (this.ai && typeof this.ai.saveBrink === 'function') {
            card = this.ai.saveBrink(p, target);
          }
          const used = card ? this.rescueTaoOf(p, card) : null;
          if (!used) continue;

          this.playCardVoice(p, used.card, 'tao');
          await this.presentCard(used.card, p, {
            dest: 'showcase',
            asName: used.asName,
            note: used.asName ? null : '濒死求桃'
          });
          await this.discardConsumed(p, used.card);
          this.healPlayer(target, 1);
          if (SGS.log) {
            const head = used.skillName
              ? p.name + ' 发动【' + used.skillName + '】，将【' +
                used.card.name + '】当【桃】对 ' + target.name + ' 使用'
              : p.name + ' 对 ' + target.name + ' 使用【桃】';
            SGS.log(head + '，' + target.name + ' 体力恢复至 ' +
              Math.max(0, target.hp) + '/' + target.maxHp + '。', 'heal');
          }
          this.ui.render(this);
          await SGS.sleep(320);
          acted = true;
        }
        if (!acted) break;
      }
      if (target.hp > 0 && SGS.log) {
        SGS.log(target.name + ' 脱离濒死状态。', 'heal');
      }
    }

    /**
     * ⑤ 弃牌阶段：手牌数超过当前体力时，弃到等于体力值。
     * ★【藏拙】：若本回合没用过锦囊牌，锦囊牌（含延时锦囊）不计入手牌上限。
     *   这里按「有效张数 = 手牌 - 免计张数」算 need。
     * ★ 弃牌阶段只发起一次弃牌（适用所有角色）：弃牌途中「手牌数小于 X 后」
     *   的补牌技能（典型是张春华【伤逝】：X = 已损失体力）会立刻把牌摸回来，
     *   若弃完再判一次 over()，就会「弃一张 → 摸回一张 → 再弃」无限循环
     *   （用户实测：1 体力 2 张牌，弃 1 张触发伤逝回到 2 张，永远弃不完）。
     *   一次弃牌必然达标：need 只按计入上限的牌计算，waitDiscard 把免计牌
     *   置灰不可选，AI 的 pickDiscards 也已按同一口径优先弃非免计牌。
     */
    async phaseDiscard(p) {
      const exempt = (c) => (typeof p.hook === 'function')
        ? !!p.hook('handLimitExempt', c) : false;
      const effective = () => p.hand.filter((c) => !exempt(c)).length;
      const limit = p.handLimit;
      const over = () => Math.max(0, effective() - limit);
      // ★【藏拙】锁定技生效时（手里确有不计入上限的锦囊牌）播一次技能大字
      if (p.hand.some(exempt)) this.announceSkill(p, '藏拙');
      if (over() === 0) {
        if (SGS.log) SGS.log(p.name + '【弃牌阶段】手牌未超限，无需弃牌。');
        return;
      }
      if (SGS.log) {
        const free = p.hand.length - effective();
        SGS.log(p.name + '【弃牌阶段】需弃置 ' + over() + ' 张（手牌上限 ' +
          limit + ' 张 = 体力 ' + p.hp + ' + 技能加成 ' +
          (limit - p.hp) + (free ? '；' + free + ' 张锦囊牌不计入上限' : '') + '）。');
      }

      // ★ 只发起一次弃牌：need 在交互前定死，弃完不再复查是否仍超限。
      const need = over();
      let ids;
      if (SGS.isDecider(p) && this.ui && typeof this.ui.waitDiscard === 'function') {
        // skip：把「不计入上限」的牌（藏拙的锦囊）置灰，保证这一次选出的
        // 牌一定能让有效张数降到上限以内。
        ids = await this.ui.waitDiscard(p, need, this, { skip: exempt });
      } else {
        ids = this.ai.pickDiscards(p, need);
        await SGS.sleep(320);
      }

      // ★ 弃掉的牌一次性全部亮出：玩家侧多张飞牌同时起飞、同时落地，
      //   展示区一次性让位，落地后才统一进弃牌堆 —— 不再一张张串行蹦。
      //   AI 手牌不可见，自动退化成原来的逐张亮出；展示区标签条数不变。
      //   图片下方标「弃置」，展示区保留到本角色回合结束才清空。
      const cards = (ids || []).map((id) => p.hand.find((c) => c.id === id)).filter(Boolean);
      if (!cards.length) {
        if (SGS.log) SGS.log(p.name + '【弃牌阶段】未弃置手牌。', 'sys');
        this.ui.render(this);
        return;
      }
      await this.presentCards(cards, p, {
        dest: 'showcase', note: '弃置',
        from: p.isHuman ? undefined : 'hero'
      });
      for (const card of cards) await this.discardConsumed(p, card);
      if (SGS.log) {
        SGS.log(p.name + ' 弃置 ' + cards.length + ' 张：' +
          (cards.map((c) => c.name).join('、') || '无') + '。');
      }
      // ★ 弃牌会让手牌跌破 X，可能触发【伤逝】询问：等它结算完再结束弃牌阶段，
      //   否则回合已经往下走、询问面板还挂着，答案回来时牌局已经换了阶段。
      if (typeof this.handBelowXSettled === 'function') {
        await this.handBelowXSettled();
      }
      this.ui.render(this);
    }

    // ⑥ 结束阶段：酒加成只在本回合有效，过期作废；展示区留到回合真正结束再清
    phaseEnd(p) {
      p.jiuBuff = false;
      if (SGS.log) SGS.log(p.name + '【结束阶段】结束。');
    }

    /**
     * 阵亡弃置：手牌 / 装备区 / 判定区的牌一次性全部进弃牌堆，
     * 展示区只给一条「XX阵亡弃置」描述，不逐张飞牌；之后才结算胜负。
     */
    async onDeath(player) {
      // ★ 打上「已阵亡」标记：isDead() 只等价于 hp<=0（濒死阶段也算），
      //   但【伤逝】这类「手牌数小于 X」的复查必须区分「濒死前」与「真死」，
      //   否则阵亡弃置后还会再摸牌。
      player.dead = true;
      // ★ 阵亡语音：只在这里触发（濒死被桃/酒救回不会走到本方法）。
      //   假 UI（headless 自测）没有 playDeathVoice 时静默跳过。
      if (this.ui && typeof this.ui.playDeathVoice === 'function') {
        this.ui.playDeathVoice(player);
      }
      const cards = SGS.Zones.list(player).map((e) => e.card).filter(Boolean);
      player.hand = [];
      player.delayed = [];
      if (player.equips && SGS.EQUIP_SLOTS) {
        SGS.EQUIP_SLOTS.forEach((s) => { player.equips[s.key] = null; });
      }
      cards.forEach((c) => this.deck.discard(c));
      if (this.ui && typeof this.ui.showDeathDiscard === 'function') {
        this.ui.showDeathDiscard(player, cards);
      } else if (this.ui && typeof this.ui.showTableCard === 'function' && cards.length) {
        cards.forEach((c) => this.ui.showTableCard(c, null, player.name + '阵亡弃置'));
      }
      if (SGS.log) {
        SGS.log(player.name + ' 阵亡，弃置其手牌、装备区与判定区的全部 ' +
          cards.length + ' 张牌。', 'dmg');
      }
      this.ui.render(this);
      // ★ 2v2：同阵营的队友阵亡 → 另一名同阵营角色摸一张牌（鼓励配合）
      if (this.teamMode) {
        const mate = this.teammatesOf(player, true)[0];
        if (mate) {
          if (SGS.log) {
            SGS.log(player.name + ' 阵亡，同阵营的 ' + mate.name + ' 摸一张牌。', 'sys');
          }
          await this.drawCards(mate, 1);
        }
      }
      // 展示区入场动画约 350ms；播完后再等 1 秒才结算胜负
      await SGS.sleep(350);
      await SGS.sleep(1000);
    }

    gameOver(winner) {
      this.over = true;
      // 无来源伤害（如【闪电】）致人死亡时，从存活角色里推胜负方
      if (!winner || (typeof winner.isDead === 'function' && winner.isDead())) {
        winner = (this.players || []).find((p) => p && !p.isDead()) || winner;
      }
      let win;
      if (this.teamMode) {
        // ★ 2v2：胜负看阵营 —— 自己所在阵营还有活人就算赢（此时对方已全灭）。
        const myTeam = this.human && this.human.team;
        win = !!myTeam && this.teamAlive(myTeam) && !this.teamAlive(myTeam === 'A' ? 'B' : 'A');
      } else {
        win = !!(winner && winner.isHuman);
      }
      if (SGS.log) {
        // 同样只写角色名（联机两端共用一份记录）
        const winnerText = this.teamMode
          ? (SGS.teamName(win ? this.human.team : (this.human.team === 'A' ? 'B' : 'A')))
          : ((winner && winner.name) || '无人');
        SGS.log('🎉 对局结束：' + winnerText + ' 获胜。', 'turn');
      }
      this.ui.showGameOver(win, this);
    }
  }

  SGS.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
