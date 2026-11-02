export interface MarketEventItemImpact {
  typeId: number;
  typeName: string;
  expectedDirection: 'surge' | 'increase' | 'stable' | 'decrease' | 'plunge';
  mechanism: string; // How the event impacts this item
  confidencePct: number; // 0 - 100
  historicalPrecedent?: string; // Evidence from past similar events
}

export interface MarketEvent {
  eventId: string;
  title: string;
  category: 'patch_notes' | 'ship_balance' | 'industry_rework' | 'event_campaign' | 'war_escalation';
  officialFact: string;       // Verified fact directly from official announcement
  impactHypothesis: string;   // Economic and supply-demand hypothesis
  impactedItems: MarketEventItemImpact[];
  sourceUrl: string;
  announcedAt: string;
  verifiedAt: string;
}

export class EventDrivenStrategy {
  /**
   * Structure and validate an event-driven market hypothesis
   */
  public static structureEventHypothesis(params: {
    eventId: string;
    title: string;
    category: MarketEvent['category'];
    officialFact: string;
    impactHypothesis: string;
    impactedItems: MarketEventItemImpact[];
    sourceUrl: string;
    announcedAt: string;
  }): MarketEvent {
    return {
      ...params,
      verifiedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    };
  }

  /**
   * Map standard game balancing patterns to affected commodity types
   */
  public static getCommonBalancingImpactMap(): Record<string, { affectedGroups: string[]; impactDescription: string }> {
    return {
      'missile_buff': {
        affectedGroups: ['巡航导弹', '重型导弹', '轻型导弹', '鱼雷'],
        impactDescription: '导弹武器增强将直接带动对应弹药与发射器消耗量的攀升，相关制造原料（类晶体胶矿、同位聚合体）需求上涨。',
      },
      'drone_nerf': {
        affectedGroups: ['战斗无人机', '岗哨无人机', '重型无人机'],
        impactDescription: '无人机削弱将导致无人机母舰及无人机伤害增效装置需求阶段性回落，替代性炮台/导弹装备需求上升。',
      },
      'industry_material_increase': {
        affectedGroups: ['矿物', '旗舰建造组件', '行星商品'],
        impactDescription: '制造原材料消耗比例提高将直接推高基础矿石与行星产物现货价格，现存成品舰船具备重估增值空间。',
      },
      'fw_frontline_war': {
        affectedGroups: ['海军护卫舰', '驱逐舰', '势力弹药', '纳米体修复贴'],
        impactDescription: '派系前线战事升级导致高安与低安交界星系轻型战舰与消耗品日消耗量倍增，LP 兑换物出现局部供给潮。',
      },
    };
  }
}