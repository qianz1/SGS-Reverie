/**
 * cards.js
 * 牌面数据定义 + 牌堆（摸牌堆 / 弃牌堆）管理。
 * 六种基本牌（杀 / 闪 / 桃 / 酒 / 火杀 / 雷杀）+ 十五种锦囊牌 + 二十二种装备牌。
 * 锦囊的「效果结算」在 tricks.js；【酒】与装备的使用结算在 game.js；
 * 装备效果的查询集中在 equipment.js；判定流程在 judge.js。
 * 本文件只负责牌面数据与构造牌堆。

 * ── 装备技能分类 ──────────────────────────────────────────
 *  · 锁定技（装上即生效）：连弩 / 坐骑 / 仁王盾 / 藤甲 / 白银狮子减伤 /
 *    青釭剑（杀无视防具）
 *  · 「可以」类（每次询问）：八卦阵（判定闪）/ 朱雀羽扇（普通杀改火杀）/
 *    寒冰剑（防止伤害改弃牌），由 Game.askOptional() 统一询问
 *  · 主动转化（点装备区武器栏触发）：丈八蛇矛（两张手牌当杀使用或打出），
 *    由 ui.openZhangba() 进入两张手牌的统一选牌动画。转化杀的颜色按素材：
 *    两红→红色、两黑→黑色、一红一黑→无色；永远无点数花色、永远是普通杀。
 *  · 失去装备触发：白银狮子的 loseHeal，由 Game.onEquipmentLost() 统一结算。
 *
 * ── 伤害属性 ────────────────────────────────────────────────
 * damageType：'normal'（普通）/ 'fire'（火焰）/ 'thunder'（雷电）。
 * 【火杀】【雷杀】都是【杀】的一种，共用出杀次数、目标规则与【酒】加成，
 * 只是结算伤害时带属性；【藤甲】按属性判定是否无效 / 是否加伤。
 *
 * ── 坐骑牌 ──────────────────────────────────────────────────
 * +1 马：绝影 / 的卢 / 爪黄飞电；-1 马：赤兔 / 紫骍 / 大宛。
 * 后四张用简写描述（只标 +1 马 / -1 马），**效果与绝影 / 赤兔完全相同**。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  const SUITS = ['\u2660', '\u2663', '\u2665', '\u2666']; // ♠ ♣ ♥ ♦
  const RED_SUITS = ['\u2665', '\u2666'];
  // 点数仅用于牌面左上角的展示（参照牌面样式），不参与任何规则结算
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  /**
   * 牌面数据：category 区分基本牌 / 锦囊牌；target 描述「使用时是否需要选目标」。
   *
   * target.mode：
   *   'other'      需要玩家显式点选一名其他角色（即便 1v1 也不自动指定）
   *   'self'       只对自己生效（桃 / 酒 / 无中生有 / 装备牌），不弹目标选择
   *   'all'        对全场每名角色生效（桃园结义），不弹选择，一对多画黄线
   *   'all-others' 对所有其他角色生效（万箭齐发 / 南蛮入侵），不弹选择，一对多画黄线
   *   'any'        显式点一名角色，可选自己也可选他人（火攻）
   *   'borrow'     显式点一名「其他 + 有武器」角色，再点攻击范围内另一名角色（借刀杀人）
   *   'chain'      显式点 1~2 名角色（可含自己），分别横置 / 重置（铁索连环）
   * maxDistance：目标距离上限（Infinity = 不限）；
   * needCards：目标**任意区域**（手牌 / 装备区 / 判定区）必须有牌，由 zones.js 统计。
   * needHand：目标必须有手牌（火攻）；needWeapon：目标装备区必须有武器（借刀杀人）。
   * 距离为 1 的【杀】对应默认攻击范围 1，顺手牵羊按原版要求距离 1。
   * 只有 mode==='other' 需要显式点选（needsTarget）；all / all-others 是
   * 自动生效的群体牌，由 Game.selectTargets() 直接对全部合法目标发起黄线。
   * category：'basic'（基本牌）/ 'trick'（锦囊）/ 'equip'（装备牌）。
   * 装备牌的 `equip` 子对象声明槽位与数值，效果由 equipment.js 统一查询。
   *
   * image：素材放 assets/cards/，按「卡牌名称拼音.webp」命名（逐字连写、
   * 每字首字母大写、不标声调，如 WuZhongShengYou.webp / ZhuGeLianNu.webp），
   * 不加势力前缀；ü 规则与通用牌背 back.webp 见 core.js 的命名注释。
   * 图片缺失或加载错误时 ui.js 会自动回退到 CSS 绘制的卡面。
   */
  const CARD_DEFS = {
    sha: {
      name: '杀',
      category: 'basic',
      image: 'Sha.webp',
      damageType: 'normal',
      target: { mode: 'other', maxDistance: 1 },
      desc: '出牌阶段，对距离为 1 的一名其他角色使用，对方需打出【闪】，否则受到 1 点伤害。每回合默认限用 1 次。'
    },
    /* 属性杀：与【杀】完全共用出杀次数 / 目标 / 酒加成，只改伤害属性 */
    huosha: {
      name: '火杀',
      category: 'basic',
      image: 'HuoSha.webp',
      damageType: 'fire',
      target: { mode: 'other', maxDistance: 1 },
      desc: '【杀】的一种：造成的伤害为火焰伤害（【藤甲】会受到 +1 火焰伤害）。'
    },
    leisha: {
      name: '雷杀',
      category: 'basic',
      image: 'LeiSha.webp',
      damageType: 'thunder',
      target: { mode: 'other', maxDistance: 1 },
      desc: '【杀】的一种：造成的伤害为雷电伤害。'
    },
    shan: {
      name: '闪',
      category: 'basic',
      image: 'Shan.webp',
      target: { mode: 'self' },
      desc: '响应【杀】时打出，抵消这次伤害。'
    },
    tao: {
      name: '桃',
      category: 'basic',
      image: 'Tao.webp',
      target: { mode: 'self' },
      desc: '出牌阶段体力未满时使用，回复 1 点体力；濒死时可使用自救，体力回到 1 点。'
    },
    wuzhong: {
      name: '无中生有',
      category: 'trick',
      image: 'WuZhongShengYou.webp',
      target: { mode: 'self' },
      desc: '出牌阶段，对自己使用。摸两张牌。'
    },
    guohe: {
      name: '过河拆桥',
      category: 'trick',
      image: 'GuoHeChaiQiao.webp',
      target: { mode: 'other', maxDistance: Infinity, needCards: true },
      desc: '出牌阶段，对一名其他有牌的角色使用。弃置其手牌区 / 装备区 / 判定区的一张牌。'
    },
    shunshou: {
      name: '顺手牵羊',
      category: 'trick',
      image: 'ShunShouQianYang.webp',
      target: { mode: 'other', maxDistance: 1, needCards: true },
      desc: '出牌阶段，对一名距离为 1 的有牌的其他角色使用。获得其手牌区 / 装备区 / 判定区的一张牌，加入自己手牌。'
    },
    jiu: {
      name: '酒',
      category: 'basic',
      image: 'Jiu.webp',
      target: { mode: 'self' },
      desc: '出牌阶段使用，本回合下一张【杀】伤害 +1，每回合限用一次；濒死时可立即使用恢复 1 点体力，次数不限。'
    },
    wanjian: {
      name: '万箭齐发',
      category: 'trick',
      image: 'WanJianQiFa.webp',
      target: { mode: 'all-others' },
      desc: '出牌阶段，对所有其他角色使用。每名目标需打出一张【闪】，否则受到 1 点伤害。'
    },
    nanman: {
      name: '南蛮入侵',
      category: 'trick',
      image: 'NanManRuQin.webp',
      target: { mode: 'all-others' },
      desc: '出牌阶段，对所有其他角色使用。每名目标需打出一张【杀】，否则受到 1 点伤害。'
    },
    taoyuan: {
      name: '桃园结义',
      category: 'trick',
      image: 'TaoYuanJieYi.webp',
      target: { mode: 'all' },
      desc: '出牌阶段，对每名角色使用。每名角色回复 1 点体力。'
    },
    juedou: {
      name: '决斗',
      category: 'trick',
      image: 'JueDou.webp',
      target: { mode: 'other', maxDistance: Infinity },
      desc: '出牌阶段，对一名其他角色使用。由目标开始轮流打出【杀】，首先不出【杀】的一方受到另一方造成的 1 点伤害。'
    },
    huogong: {
      name: '火攻',
      category: 'trick',
      image: 'HuoGong.webp',
      target: { mode: 'any', maxDistance: Infinity, needHand: true },
      desc: '出牌阶段，对一名有手牌的角色使用（可选自己）。该角色展示一张手牌；若你弃置一张与其花色相同的手牌，则对其造成 1 点火焰伤害。'
    },
    /* ★【出其不意】只由【破竹】（杜预）把一张手牌转化出来使用，
       不进入 DECK_LAYOUT，因此摸牌堆 / 弃牌堆里永远不会出现这张牌。 */
    chubuyi: {
      name: '出其不意',
      category: 'trick',
      image: 'ChuBuYi.webp',
      target: { mode: 'other', maxDistance: Infinity, needHand: true },
      desc: '出牌阶段，对一名有手牌的其他角色使用。你展示其一张手牌，若此牌与【出其不意】花色不同，你对其造成 1 点伤害。'
    },
    jiedaosharen: {
      name: '借刀杀人',
      category: 'trick',
      image: 'JieDaoShaRen.webp',
      target: { mode: 'borrow', maxDistance: Infinity, needWeapon: true },
      desc: '出牌阶段，对一名装备区有武器的其他角色使用。除非该角色对其攻击范围内由你选择的另一名角色使用一张【杀】（可以是你），否则将其武器交给你。'
    },
    wugufengdeng: {
      name: '五谷丰登',
      category: 'trick',
      image: 'WuGuFengDeng.webp',
      target: { mode: 'all' },
      desc: '出牌阶段，对所有角色使用。你从牌堆顶亮出等同于现存角色数量的牌，每名角色从这些牌中选择并获得一张（从你开始按逆时针顺序依次选择）。'
    },
    tiesuolianhuan: {
      name: '铁索连环',
      category: 'trick',
      image: 'TieSuoLianHuan.webp',
      target: { mode: 'chain', maxDistance: Infinity, minTargets: 1, maxTargets: 2 },
      desc: '出牌阶段，指定一至两名角色，分别横置或重置其武将牌。横置的角色处于「连环状态」：其中一人受到属性伤害后，其他连环状态角色依次受到同来源、同程度、同属性的伤害并全部重置。你也可将本牌弃置并重铸（摸一张牌），重铸不视为使用。'
    },

    /* ── 延时锦囊牌（category 仍是 trick，使用后进入目标的判定区）────
       mark / markShort：判定区图标（assets/marks/）与图片加载失败时的文字回退。
       判定在角色自己的「判定阶段」进行，具体效果在 game.phaseJudge() 结算。 */
    lebusishu: {
      name: '乐不思蜀',
      category: 'trick',
      image: 'LeBuSiShu.webp',
      target: { mode: 'other', maxDistance: Infinity },
      delayed: true,
      mark: 'LeBuSiShu.png',
      markShort: '乐',
      desc: '延时锦囊牌：出牌阶段，对一名其他角色使用，将此牌置入其判定区。该角色判定阶段时，若判定结果不为红桃，则跳过其出牌阶段。'
    },
    bingliangcunduan: {
      name: '兵粮寸断',
      category: 'trick',
      image: 'BingLiangCunDuan.webp',
      target: { mode: 'other', maxDistance: 1 },
      delayed: true,
      mark: 'BingLiangCunDuan.png',
      markShort: '兵',
      desc: '延时锦囊牌：出牌阶段，对距离为 1 的一名其他角色使用，将此牌置入其判定区。该角色判定阶段时，若判定结果不为梅花，则跳过其摸牌阶段。'
    },
    shandian: {
      name: '闪电',
      category: 'trick',
      image: 'ShanDian.webp',
      target: { mode: 'self' },
      delayed: true,
      mark: 'ShanDian.png',
      markShort: '雷',
      desc: '延时锦囊牌：出牌阶段，对自己使用，将此牌置入你的判定区。判定阶段时，若判定结果为黑桃 2~9，你受到 3 点雷电伤害；否则将此牌置入下家的判定区。'
    },
    wuxiekeji: {
      name: '无懈可击',
      category: 'trick',
      image: 'WuXieKeJi.webp',
      // 响应专用：只能在锦囊 / 另一张无懈可击生效前打出，不能在出牌阶段主动使用
      target: { mode: 'self' },
      responseOnly: true,
      desc: '锦囊牌：在目标锦囊牌生效前，抵消其对一名角色产生的效果；也可以抵消另一张【无懈可击】的效果。不能主动使用。'
    },

    /* ── 装备牌（category:'equip'）─────────────────────────────
       equip.slot：weapon / armor / horsePlus / horseMinus
       equip.range：武器攻击范围；distanceBonus / distanceReduce：坐骑修正
       equip.unlimitedSha / blocksBlackSha：锁定技开关
       note / short：装备栏里显示的一行说明（玩家栏 / 对方迷你栏）。 */
    zhugeliannu: {
      name: '诸葛连弩',
      category: 'equip',
      image: 'ZhuGeLianNu.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 1, unlimitedSha: true,
        note: '攻击范围 1', short: '攻1'
      },
      desc: '装备/武器：攻击范围 1。锁定技，你使用【杀】无次数限制。'
    },
    jueying: {
      name: '绝影',
      category: 'equip',
      image: 'JueYing.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'horsePlus', distanceBonus: 1,
        note: '距离 +1', short: '距+1'
      },
      desc: '装备/坐骑：锁定技，其他角色计算与你的距离时，始终 +1。'
    },
    chitu: {
      name: '赤兔',
      category: 'equip',
      image: 'ChiTu.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'horseMinus', distanceReduce: 1,
        note: '距离 -1', short: '距-1'
      },
      desc: '装备/坐骑：锁定技，你计算与其他角色的距离时，始终 -1。'
    },
    renwangdun: {
      name: '仁王盾',
      category: 'equip',
      image: 'RenWangDun.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'armor', blocksBlackSha: true,
        note: '', short: ''
      },
      desc: '装备/防具：锁定技，黑色的【杀】对你无效。'
    },

    /* ── 坐骑牌（描述简写为 +1 马 / -1 马，效果与绝影 / 赤兔完全一致）──
       文件名按「卡牌名称拼音.webp」逐字连写、每字首字母大写：
       ZiXing / DiLu / ZhuaHuangFeiDian / DaYuan。 */
    zixing: {
      name: '紫骍',
      category: 'equip',
      image: 'ZiXing.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'horseMinus', distanceReduce: 1,
        note: '距离 -1', short: '距-1'
      },
      desc: '装备/坐骑：-1 马（效果同【赤兔】）。'
    },
    dilu: {
      name: '的卢',
      category: 'equip',
      image: 'DiLu.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'horsePlus', distanceBonus: 1,
        note: '距离 +1', short: '距+1'
      },
      desc: '装备/坐骑：+1 马（效果同【绝影】）。'
    },
    zhuahuangfeidian: {
      name: '爪黄飞电',
      category: 'equip',
      image: 'ZhaoHuangFeiDian.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'horsePlus', distanceBonus: 1,
        note: '距离 +1', short: '距+1'
      },
      desc: '装备/坐骑：+1 马（效果同【绝影】）。'
    },
    dayuan: {
      name: '大宛',
      category: 'equip',
      image: 'DaYuan.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'horseMinus', distanceReduce: 1,
        note: '距离 -1', short: '距-1'
      },
      desc: '装备/坐骑：-1 马（效果同【赤兔】）。'
    },
    hualiu: {
      name: '骅骝',
      category: 'equip',
      image: 'HuaLiu.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'horseMinus', distanceReduce: 1,
        note: '距离 -1', short: '距-1'
      },
      desc: '装备/坐骑：-1 马（效果同【赤兔】）。'
    },

    /* 藤甲：普通杀 / 南蛮入侵 / 万箭齐发无效；受到火焰伤害时该伤害 +1。
       fireVulnerable 由 Game.damage() 读取，blocksNormalSha / blocksAOE 由
       equipment.js 查询。 */
    tengjia: {
      name: '藤甲',
      category: 'equip',
      image: 'TengJia.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'armor', blocksNormalSha: true, blocksAOE: true, fireVulnerable: true,
        note: '', short: ''
      },
      desc: '装备/防具：锁定技，【南蛮入侵】、【万箭齐发】和普通【杀】对你无效；当你受到火焰伤害时，此伤害 +1。'
    },

    /* ── 白银狮子 ─────────────────────────────────────────────
       damageCap: 大于 1 点的伤害减至 1 点（Game.damage 读取，锁定技）；
       loseHeal: 失去装备区里的这张牌（含被替换 / 被拆 / 被牵）回复 1 点体力，
       由 Game.onEquipmentLost() 统一结算。 */
    baiyinshizi: {
      name: '白银狮子',
      category: 'equip',
      image: 'BaiYinShiZi.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'armor', damageCap: 1, loseHeal: 1,
        note: '', short: ''
      },
      desc: '装备/防具：锁定技，当你受到大于 1 点的伤害时，此伤害减至 1 点；当你失去装备区里的【白银狮子】后，你回复 1 点体力。'
    },

    /* ── 八卦阵 ───────────────────────────────────────────────
       bagua: 需要【闪】时可判定（「可以」类，Game.askRespond 里询问），
       判定结果为红色则视为使用/打出一张【闪】。判定流程见 judge.js。 */
    baguazhen: {
      name: '八卦阵',
      category: 'equip',
      image: 'BaGuaZhen.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'armor', bagua: true,
        note: '', short: ''
      },
      desc: '装备/防具：当你需要使用或打出【闪】时，你可以进行一次判定：若结果为红色，则视为你使用或打出了一张【闪】。'
    },

    /* ── 朱雀羽扇 ─────────────────────────────────────────────
       zhuque: 使用普通【杀】时可改为火【杀】（「可以」类，Game.useSha 里询问）。
       转化只改伤害属性，牌仍是原来那张普通杀。 */
    zhuqueyushan: {
      name: '朱雀羽扇',
      category: 'equip',
      image: 'ZhuQueYuShan.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 4, zhuque: true,
        note: '攻击范围 4', short: '攻4'
      },
      desc: '装备/武器：攻击范围 4。当你使用普通【杀】时，你可以将此【杀】改为火【杀】。'
    },

    /* ── 青釭剑 ───────────────────────────────────────────────
       ignoreArmor：锁定技，【杀】指定目标后无视其防具。
       Game.useSha() 里把 armorNegated 一路传给 blockingArmor / askRespond /
       damage()，使仁王盾、藤甲、八卦阵、白银狮子在这次杀里全部失效。 */
    qinggangjian: {
      name: '青釭剑',
      category: 'equip',
      image: 'QingGangJian.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 2, ignoreArmor: true,
        note: '攻击范围 2', short: '攻2'
      },
      desc: '装备/武器：攻击范围 2。锁定技，你的【杀】指定目标后，无视其防具。'
    },

    /* ── 丈八蛇矛 ─────────────────────────────────────────────
       zhangba：主动转化技，与其它被动 / 询问型装备不同。
       触发条件 = 点玩家装备区「武器」栏里的【丈八蛇矛】→ 统一选两张手牌
       → 确认，当作一张【杀】使用（出牌阶段）或打出（响应需要杀）。
       颜色规则（SGS.Cards.zhangbaShaColor）：
         两红 → 红色【杀】；两黑 → 黑色【杀】；一红一黑 → 无色【杀】。
       永远无点数 / 无花色、伤害属性固定普通（不带火 / 雷），与素材是
       普通杀 / 火杀 / 雷杀无关。两黑的黑杀会被【仁王盾】挡下。
       ui.openZhangba() 负责选牌，Game.useZhangbaSha() / zhangbaRespond() 结算。 */
    zhangbashemao: {
      name: '丈八蛇矛',
      category: 'equip',
      image: 'ZhangBaSheMao.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 3, zhangba: true,
        note: '攻击范围 3', short: '攻3'
      },
      desc: '装备/武器：攻击范围 3。你可以将两张手牌当【杀】使用或打出（点武器栏发动）。颜色按两张牌：两红为红杀、两黑为黑杀、一红一黑为无色杀；永远是普通杀。'
    },

    /* ── 寒冰剑 ───────────────────────────────────────────────
       hanbing：「可以」类，杀将要造成伤害时，若目标「有牌」（手牌区 +
       装备区，**不含判定区**），可防止此伤害，改为依次弃置其
       两张牌（不足两张则弃一张）。弃牌走与过河拆桥相同的目标牌区面板，
       弃掉装备区的【白银狮子】同样触发 onEquipmentLost() 回血。 */
    hanbingjian: {
      name: '寒冰剑',
      category: 'equip',
      image: 'HanBingJian.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 2, hanbing: true,
        note: '攻击范围 2', short: '攻2'
      },
      desc: '装备/武器：攻击范围 2。当你使用【杀】造成伤害时，若目标有牌（不含判定区），你可以防止此伤害，改为依次弃置其两张牌。'
    },
    qilingong: {
      name: '麒麟弓',
      category: 'equip',
      image: 'QiLinGong.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 5, qilin: true,
        note: '攻击范围 5', short: '攻5'
      },
      desc: '装备/武器：攻击范围 5。当你使用【杀】对目标角色造成伤害时，你可以弃置其装备区里的一张坐骑牌。'
    },
    cixiongshuanggujian: {
      name: '雌雄双股剑',
      category: 'equip',
      image: 'CiXiongShuangGuJian.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 2, cixiong: true,
        note: '攻击范围 2', short: '攻2'
      },
      desc: '装备/武器：攻击范围 2。当你使用【杀】指定一名异性角色为目标后，你可以令其选择：弃置一张手牌，或令你摸一张牌。'
    },
    guanshifu: {
      name: '贯石斧',
      category: 'equip',
      image: 'GuanShiFu.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 3, guanshi: true,
        note: '攻击范围 3', short: '攻3'
      },
      desc: '装备/武器：攻击范围 3。当你使用的【杀】被【闪】抵消时，你可以弃置两张牌，则此【杀】仍然造成伤害。'
    },
    fangtianhuaji: {
      name: '方天画戟',
      category: 'equip',
      image: 'FangTianHuaJi.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 4, fangtian: true,
        note: '攻击范围 4', short: '攻4'
      },
      desc: '装备/武器：攻击范围 4。锁定技，若你使用的【杀】是你最后的手牌，则此【杀】可以多选择两个目标。'
    },
    qinglongyanyuedao: {
      name: '青龙偃月刀',
      category: 'equip',
      image: 'QingLongYanYueDao.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 3, qinglong: true,
        note: '攻击范围 3', short: '攻3'
      },
      desc: '装备/武器：攻击范围 3。当你使用的【杀】被【闪】抵消时，你可以对其使用一张【杀】。'
    },
    gudingdao: {
      name: '古锭刀',
      category: 'equip',
      image: 'GuDingDao.webp',
      target: { mode: 'self' },
      equip: {
        slot: 'weapon', range: 2, guding: true,
        note: '攻击范围 2', short: '攻2'
      },
      desc: '装备/武器：攻击范围 2。锁定技，当你使用【杀】对目标角色造成伤害时，若该角色没有手牌，此伤害 +1。'
    }
  };

  /**
   * 牌堆按用户给定的「点数 × 花色」表精确生成（共 160 张）。
   * 同一格里写多个牌名表示该点数花色下有多张不同的牌（例如红桃 A 有 3 张）。
   */
  const DECK_LAYOUT = {
    'A':  { '♥': ['taoyuan', 'wanjian', 'wuxiekeji'],
            '♦': ['zhugeliannu', 'juedou', 'zhuqueyushan'],
            '♣': ['zhugeliannu', 'juedou', 'baiyinshizi'],
            '♠': ['shandian', 'juedou', 'gudingdao'] },
    '2':  { '♥': ['shan', 'shan', 'huogong'],
            '♦': ['shan', 'shan', 'tao'],
            '♣': ['sha', 'baguazhen', 'tengjia', 'renwangdun'],
            '♠': ['cixiongshuanggujian', 'baguazhen', 'tengjia', 'hanbingjian'] },
    '3':  { '♥': ['tao', 'wugufengdeng', 'huogong'],
            '♦': ['shan', 'shunshou', 'tao'],
            '♣': ['sha', 'guohe', 'jiu'],
            '♠': ['shunshou', 'guohe', 'jiu'] },
    '4':  { '♥': ['tao', 'wugufengdeng', 'huosha'],
            '♦': ['shan', 'shunshou', 'huosha'],
            '♣': ['sha', 'guohe', 'bingliangcunduan'],
            '♠': ['shunshou', 'guohe', 'leisha'] },
    '5':  { '♥': ['chitu', 'qilingong', 'tao'],
            '♦': ['shan', 'guanshifu', 'huosha'],
            '♣': ['dilu', 'sha', 'leisha'],
            '♠': ['jueying', 'qinglongyanyuedao', 'leisha'] },
    '6':  { '♥': ['tao', 'lebusishu', 'tao'],
            '♦': ['sha', 'shan', 'shan'],
            '♣': ['sha', 'lebusishu', 'leisha'],
            '♠': ['qinggangjian', 'lebusishu', 'leisha'] },
    '7':  { '♥': ['tao', 'wuzhong', 'huosha'],
            '♦': ['sha', 'shan', 'shan'],
            '♣': ['sha', 'nanman', 'leisha'],
            '♠': ['sha', 'nanman', 'leisha'] },
    '8':  { '♥': ['tao', 'wuzhong', 'shan'],
            '♦': ['sha', 'shan', 'shan'],
            '♣': ['sha', 'sha', 'leisha'],
            '♠': ['sha', 'sha', 'leisha'] },
    '9':  { '♥': ['tao', 'wuzhong', 'shan'],
            '♦': ['sha', 'shan', 'jiu'],
            '♣': ['sha', 'sha', 'jiu'],
            '♠': ['sha', 'sha', 'jiu'] },
    '10': { '♥': ['sha', 'sha', 'huosha'],
            '♦': ['sha', 'shan', 'shan'],
            '♣': ['sha', 'sha', 'tiesuolianhuan'],
            '♠': ['sha', 'sha', 'bingliangcunduan'] },
    'J':  { '♥': ['sha', 'wuzhong', 'shan'],
            '♦': ['shan', 'shan', 'shan'],
            '♣': ['sha', 'sha', 'tiesuolianhuan'],
            '♠': ['shunshou', 'wuxiekeji', 'tiesuolianhuan'] },
    'Q':  { '♥': ['tao', 'guohe', 'shan', 'shandian'],
            '♦': ['tao', 'fangtianhuaji', 'huogong', 'wuxiekeji'],
            '♣': ['jiedaosharen', 'wuxiekeji', 'tiesuolianhuan'],
            '♠': ['zhangbashemao', 'guohe', 'tiesuolianhuan'] },
    'K':  { '♥': ['shan', 'zhuahuangfeidian', 'wuxiekeji'],
            '♦': ['sha', 'zixing', 'hualiu'],
            '♣': ['jiedaosharen', 'wuxiekeji', 'tiesuolianhuan'],
            '♠': ['nanman', 'dayuan', 'wuxiekeji'] }
  };

  /** 从牌表派生的牌型数量（供测试与展示用） */
  const COUNTS = {};
  Object.keys(DECK_LAYOUT).forEach((rank) => {
    Object.keys(DECK_LAYOUT[rank]).forEach((suit) => {
      DECK_LAYOUT[rank][suit].forEach((type) => {
        COUNTS[type] = (COUNTS[type] || 0) + 1;
      });
    });
  });

  /**
   * 六种基本牌（【渐营】「当任意一张基本牌使用」的可选牌型）。
   * 杀家族三种 + 闪 / 桃 / 酒；延时锦囊与装备都不在此列。
   */
  const BASIC_TYPES = ['sha', 'shan', 'tao', 'jiu', 'huosha', 'leisha'];

  SGS.Cards = {
    defs: CARD_DEFS,
    counts: COUNTS,
    BASIC_TYPES: BASIC_TYPES,

    isBasic(type) {
      return BASIC_TYPES.indexOf(type) >= 0;
    },

    nameOf(type) {
      return CARD_DEFS[type] ? CARD_DEFS[type].name : type;
    },

    /**
     * ★ 点数的数值：A=1、2~10、J=11、Q=12、K=13。
     *   【称象】这类「点数和不超过 13 / 恰好 13」的技能按它计算。
     *   牌面 rank 一直是字符串（RANKS），非法值按 0 处理，不会算出 NaN。
     */
    pointOf(card) {
      if (!card) return 0;
      const r = String(card.rank == null ? '' : card.rank).toUpperCase();
      if (r === 'A') return 1;
      if (r === 'J') return 11;
      if (r === 'Q') return 12;
      if (r === 'K') return 13;
      const n = parseInt(r, 10);
      return isNaN(n) ? 0 : n;
    },

    /** 图片文件名（拼音 + .webp），无则回退到 CSS 绘制的卡面 */
    imageOf(type) {
      return CARD_DEFS[type] ? CARD_DEFS[type].image : null;
    },

    /** 这张牌的目标规则（缺省视为只对自己生效，不弹目标选择） */
    targetOf(type) {
      return (CARD_DEFS[type] && CARD_DEFS[type].target) || { mode: 'self' };
    },

    /** 使用时是否需要显式点选一名其他角色 */
    needsTarget(type) {
      return this.targetOf(type).mode === 'other';
    },

    /** 是否为自动对多目标生效的群体牌（all / all-others，一对多黄线） */
    isAOE(type) {
      const m = this.targetOf(type).mode;
      return m === 'all' || m === 'all-others';
    },

    /** 该牌是否为锦囊牌（只看牌面类型，手工构造的测试牌也能正确识别） */
    isTrick(type) {
      return !!(CARD_DEFS[type] && CARD_DEFS[type].category === 'trick');
    },

    /** 是否为延时锦囊牌（使用后进入判定区，而非立即弃置） */
    isDelayed(type) {
      return !!(CARD_DEFS[type] && CARD_DEFS[type].delayed);
    },

    /** 该牌是否为装备牌 */
    isEquip(type) {
      return !!(CARD_DEFS[type] && CARD_DEFS[type].category === 'equip');
    },

    /** 装备效果数据（槽位 / 攻击范围 / 距离修正 / 锁定技开关） */
    equipOf(type) {
      return (CARD_DEFS[type] && CARD_DEFS[type].equip) || null;
    },

    /**
     * 【杀】家族：普通【杀】/【火杀】/【雷杀】都是「杀」，
     * 共用目标规则、出杀次数、酒加成与响应判定。
     */
    isSha(type) {
      return type === 'sha' || type === 'huosha' || type === 'leisha';
    },

    /** 伤害属性：牌实例自带 damageType 优先，否则查牌面定义，缺省普通 */
    damageTypeOf(card) {
      if (!card) return 'normal';
      if (card.damageType) return card.damageType;
      const d = CARD_DEFS[card.type];
      return (d && d.damageType) || 'normal';
    },

    /**
     * 【丈八蛇矛】两张手牌转化出的【杀】颜色：
     *   两红 → 'red'；两黑 → 'black'；一红一黑（或颜色缺失）→ null（无色）。
     * 只取决于两张素材牌的 color，与素材是什么牌无关。转化杀永远无点数、
     * 无花色、伤害属性固定 normal（不带火 / 雷），由 Game.useZhangbaSha()
     * 构造 asSha 时写死，因此素材即使是【火杀】【雷杀】也只得到普通杀。
     * 【仁王盾】按 shaCard.color === 'black' 判黑杀，所以「两黑」会被挡，
     * 「两红 / 无色」不会 —— 这一层纯数据规则可直接被 Node 自测验证。
     */
    zhangbaShaColor(cards) {
      if (!Array.isArray(cards) || cards.length !== 2) return null;
      const a = cards[0] && cards[0].color;
      const b = cards[1] && cards[1].color;
      if (a === b && (a === 'red' || a === 'black')) return a;
      return null;
    },

    /** 上面那个颜色的人类可读名字，用于日志与引导（无色 = 一红一黑） */
    zhangbaShaColorName(cards) {
      const c = this.zhangbaShaColor(cards);
      return c === 'red' ? '红色' : c === 'black' ? '黑色' : '无色';
    },

    /** 牌面能否直接「打出」响应 need（杀家族一起算杀） */
    matchesRespond(card, need) {
      if (!card) return false;
      return need === 'sha' ? this.isSha(card.type) : card.type === need;
    },

    /** 牌面是否属于某个转化来源（'sha' 覆盖整个杀家族） */
    matchesType(card, type) {
      if (!card) return false;
      return type === 'sha' ? this.isSha(card.type) : card.type === type;
    },

    /**
     * 技能转化项的「来源」匹配：花色、颜色、牌型三合一。
     *   · '♥' / '♦' / '♣' / '♠' → 按 card.suit 精确匹配（【龙魂】用）
     *   · 'red' / 'black'        → 按 card.color 匹配，缺省时按花色补
     *   · 其它字符串（'shan' / 'sha' / 具体牌型）→ 沿用 matchesType()
     * 旧的龙胆 conversions 里 from='shan' / 'sha' 走最后一支，行为完全不变。
     * 单独提供这一层，让 ui.js / game.js / 角色文件共用同一套花色判定，
     * 不必在三个地方各写一遍 suit 比较。
     */
    matchesFrom(card, from) {
      if (!card || !from) return false;
      // ★ 'any' / '*'：任意一张牌都能作为转化素材（【渐营】将一张牌当基本牌）
      if (from === 'any' || from === '*') return true;
      if (from === '\u2665' || from === '\u2666' ||
          from === '\u2663' || from === '\u2660') return card.suit === from;
      if (from === 'red' || from === 'black') {
        const c = card.color ||
          (RED_SUITS.indexOf(card.suit) >= 0 ? 'red' : 'black');
        return c === from;
      }
      return this.matchesType(card, from);
    },

    /** 构造一副按预设点数 / 花色表生成并洗好的牌（160 张） */
    buildDeck() {
      const list = [];
      Object.keys(DECK_LAYOUT).forEach((rank) => {
        Object.keys(DECK_LAYOUT[rank]).forEach((suit) => {
          DECK_LAYOUT[rank][suit].forEach((type) => {
            list.push({
              id: SGS.uid('card'),
              type: type,
              name: CARD_DEFS[type].name,
              category: CARD_DEFS[type].category || 'basic',
              image: CARD_DEFS[type].image || null,
              equip: CARD_DEFS[type].equip || null,
              damageType: CARD_DEFS[type].damageType || 'normal',
              rank: rank,
              suit: suit,
              color: RED_SUITS.indexOf(suit) >= 0 ? 'red' : 'black'
            });
          });
        });
      });
      return SGS.shuffle(list);
    }
  };

  /** 牌堆：摸牌堆见底时自动把弃牌堆洗回 */
  class Deck {
    constructor() {
      this.drawPile = SGS.Cards.buildDeck();
      this.discardPile = [];
    }

    /** 摸 n 张牌，返回牌数组 */
    draw(n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        if (this.drawPile.length === 0) {
          if (this.discardPile.length === 0) break; // 全牌耗尽，停止摸牌
          this.drawPile = SGS.shuffle(this.discardPile);
          this.discardPile = [];
          if (SGS.log) SGS.log('牌堆已空，弃牌堆重新洗入牌堆。', 'sys');
        }
        out.push(this.drawPile.pop());
      }
      return out;
    }

    /** 牌进入弃牌堆 */
    discard(cards) {
      (Array.isArray(cards) ? cards : [cards]).forEach((c) => {
        if (c) this.discardPile.push(c);
      });
    }

    /**
     * ★【火计】观看牌堆顶 n 张：只读，不移除，返回「最上方在前」的数组。
     * draw() 用 pop()，所以牌堆顶 = drawPile 的最后一个元素。
     */
    peekTop(n) {
      const k = Math.min(Math.max(0, n | 0), this.drawPile.length);
      return this.drawPile.slice(this.drawPile.length - k).reverse();
    }

    /**
     * ★【火计】把一组牌以指定顺序放回牌堆顶（order[0] 成为新的牌堆顶，
     * 下一次 draw() 最先摸到）。cards 应全部来自刚取出的牌堆顶牌，
     * 调用方负责把它们从 drawPile 里先取走（deck.draw(n)）。
     */
    putOnTop(cards) {
      const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
      // 倒序 push：order[0] 最后入栈 → 位于数组末尾 → pop 时最先被摸到
      for (let i = list.length - 1; i >= 0; i--) this.drawPile.push(list[i]);
      return list.length;
    }

    get remaining() {
      return this.drawPile.length;
    }
  }

  SGS.Deck = Deck;
})(typeof window !== 'undefined' ? window : globalThis);
