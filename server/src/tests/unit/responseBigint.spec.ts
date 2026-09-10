/**
 * @file server/src/tests/unit/responseBigint.spec.ts
 * @description 响应体 BigInt 序列化单测：`jsonReplacer` 行为 + Express `json replacer` 接线回归锁
 * @module tests/unit
 * @see server/src/core/response.ts:34（jsonReplacer）、server/src/app.ts:122（app.set('json replacer', ...)）
 * @see docs/03-database.md §1.2（金额一律 BIGINT，单位「分」）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 为什么必须有这批用例（**阻塞级缺陷**）：
 * Prisma 读 MySQL `BIGINT` 返回 JS `bigint`，而原生 `JSON.stringify` 遇到 bigint 直接抛
 * `TypeError: Do not know how to serialize a BigInt`。金额字段（price / minPrice / maxPrice …）
 * 全是 BIGINT，因此**只要 `app.set('json replacer', jsonReplacer)` 这一行没接上，
 * 全站所有带金额的接口一律 500**。这个缺陷 `tsc` 检查不出来（类型上完全合法），
 * 集成测试又依赖 MySQL / Redis 实例跑不起来，只能靠单测锁死。
 *
 * 三条防线：
 * 1. 纯函数层：`jsonReplacer` 本身的转换规则（bigint → number / 超安全范围 → 字符串 / Date → ISO）；
 * 2. 框架层：最小 express app 设置 `json replacer` 后，返回含 bigint 的对象必须是 200；
 * 3. 接线层：`createApp()` 必须真的把 `json replacer` 设上（回归锁）。
 *
 * ⚠️ 第 3 条依赖 `src/app.ts` 的落地情况；若并发工程师尚未改完 app.ts，该用例会**明确失败**，
 * 这是预期行为（用于催办），不要为了让测试变绿而删掉这条断言。
 */

import { describe, expect, it, jest } from '@jest/globals';

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，
// 因此用假 config 注入固定值，避免加载真实配置
jest.mock('@/config', () => ({
  config: {
    env: 'test',
    redis: { keyPrefix: 'shop' },
    // logger 在 import 时即读 config.log.level 建 winston 实例，缺了会让整个套件起不来
    log: { level: 'error', dir: '' },
    // createApp() 会读 security.trustProxy / security.bodyLimit / cors.origins / rateLimit.enabled
    security: { trustProxy: 0, bodyLimit: '1mb' },
    cors: { origins: ['http://localhost:5173'] },
    rateLimit: { enabled: false },
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

// 单例在模块加载时会调用 getPrisma()，用假实现避免建真实客户端
jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
  isPrismaHealthy: jest.fn(async () => true),
}));

// CacheService / 限流中间件的默认 provider 取这里的 getRedis，默认返回 null（模拟「无 Redis 实例」）
jest.mock('@/core/redis', () => ({
  getRedis: jest.fn(() => null),
  isRedisAvailable: jest.fn(() => false),
}));

import express, { type Application } from 'express';
import request from 'supertest';
import { jsonReplacer } from '@/core/response';

/** JS 安全整数上限（9,007,199,254,740,991） */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------
// 一、jsonReplacer 纯函数
// ---------------------------------------------------------------------------

describe('jsonReplacer', () => {
  it('安全范围内的 bigint → number（金额「分」的常规路径）', () => {
    expect(jsonReplacer('price', 9900n)).toBe(9900);
    expect(typeof jsonReplacer('price', 9900n)).toBe('number');
    // 0 与负数同样处理
    expect(jsonReplacer('price', 0n)).toBe(0);
    expect(jsonReplacer('delta', -100n)).toBe(-100);
    // 边界：恰好等于安全上限仍走 number
    expect(jsonReplacer('max', MAX_SAFE)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('超出 Number.MAX_SAFE_INTEGER 的 bigint → 字符串，绝不静默丢精度', () => {
    const overflow = MAX_SAFE + 1n;

    expect(jsonReplacer('amount', overflow)).toBe('9007199254740992');
    expect(typeof jsonReplacer('amount', overflow)).toBe('string');
    // 负方向同样降级：丢精度的负数会把「欠款」算成别的数，性质一样严重
    expect(jsonReplacer('amount', -overflow)).toBe('-9007199254740992');
    expect(typeof jsonReplacer('amount', -overflow)).toBe('string');
    // 反证：直接 Number() 会静默丢精度（这正是必须降级为字符串的原因）。
    // 2^53 + 1 无法被 double 精确表示，Number() 会把它四舍五入回 2^53
    const lossy = MAX_SAFE + 2n;
    expect(Number(lossy)).toBe(9007199254740992);
    expect(jsonReplacer('amount', lossy)).toBe('9007199254740993');
  });

  it('Date → ISO 字符串；普通值原样返回', () => {
    const iso = '2026-09-06T00:00:00.000Z';
    expect(jsonReplacer('createdAt', new Date(iso))).toBe(iso);

    expect(jsonReplacer('name', '旗舰手机')).toBe('旗舰手机');
    expect(jsonReplacer('total', 7)).toBe(7);
    expect(jsonReplacer('ok', true)).toBe(true);
    expect(jsonReplacer('nothing', null)).toBeNull();
    expect(jsonReplacer('list', [1, 2])).toEqual([1, 2]);
    expect(jsonReplacer('obj', { a: 1 })).toEqual({ a: 1 });
  });

  it('反证：不加 replacer 时 JSON.stringify 直接抛 TypeError（全站金额接口 500 的根因）', () => {
    const payload = { price: 9900n };

    expect(() => JSON.stringify(payload)).toThrow(TypeError);
    expect(() => JSON.stringify(payload)).toThrow(/BigInt/i);
    // 加了 replacer 之后同一份载荷能正常序列化，且金额是 number
    expect(JSON.stringify(payload, jsonReplacer)).toBe('{"price":9900}');
  });
});

// ---------------------------------------------------------------------------
// 二、Express 接线
// ---------------------------------------------------------------------------

describe('Express json replacer 接线', () => {
  it('最小 express app 设置 json replacer 后：含 bigint 的响应是 200，且金额是 number', async () => {
    const app = express();
    app.set('json replacer', jsonReplacer);
    app.get('/api/money', (_req, res) => {
      res.json({ productId: 1n, name: '旗舰手机', price: 9900n, minPrice: 9900n, maxPrice: 299900n });
    });

    const response = await request(app).get('/api/money');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      productId: 1,
      name: '旗舰手机',
      price: 9900,
      minPrice: 9900,
      maxPrice: 299900,
    });
    expect(typeof response.body.price).toBe('number');
    expect(typeof response.body.productId).toBe('number');
  });

  it('回归锁：createApp() 必须设置 json replacer，且它确实能把 bigint 转成 number', async () => {
    let factory: (() => Application) | undefined;
    let loadError: unknown;

    /**
     * 这里刻意用**动态 import + try/catch**而不是顶层静态 import：
     * `src/app.ts` 正由并发工程师修改（挂载商品 / SKU 路由），一旦它处于编译中间态，
     * 静态 import 会让**整个文件**连 jsonReplacer 自身的用例一起起不来；
     * 动态 import 把失败范围约束在这一条用例内，其余防线照常运行。
     */
    try {
      const mod = await import('@/app');
      factory = mod.createApp;
    } catch (error) {
      loadError = error;
    }

    if (factory === undefined) {
      throw new Error(
        '【阻塞：等待 app.ts 接线】src/app.ts 当前无法加载（并发工程师正在修改 app.ts / ' +
          `routes/api/product.routes.ts / controllers/SkuController.ts）。原始错误：${String(loadError)}`,
      );
    }

    const app = factory();
    const replacer = app.get('json replacer') as ((key: string, value: unknown) => unknown) | undefined;

    expect(typeof replacer).toBe('function');
    // 光是 function 还不够：必须是真的能兜住 bigint 的那个 replacer
    expect(replacer?.('price', 9900n)).toBe(9900);
    expect(replacer?.('createdAt', new Date('2026-09-06T00:00:00.000Z'))).toBe('2026-09-06T00:00:00.000Z');
  });
});
