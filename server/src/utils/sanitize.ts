/**
 * @file server/src/utils/sanitize.ts
 * @description 输入清洗：富文本标签过滤、HTML 转义、SQL LIKE 通配符转义、空白归一化
 * @module utils
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 定位说明：
 * 这里是**深度防御的第二道**，第一道永远是 zod 校验（`middlewares/validate.ts`）。
 * 只靠 zod 挡不住「合法但危险」的输入，例如商品详情里带 `<script>` 的富文本 ——
 * 它通过 `z.string().min(1)` 完全合法，却会在后台列表页触发 XSS。
 */

/** 需要转义的 HTML 字符 → 实体 */
const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 转义 HTML 特殊字符。
 *
 * @description 输出到页面前的最后一道防线；富文本字段在**入库前**应先过 {@link stripHtml}
 * @param input 原始字符串
 * @returns 转义后的字符串
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

/**
 * 移除所有 HTML 标签。
 *
 * @description 用于「不允许富文本」的纯文本字段（商品名、地址、备注）。
 * 注意：这不是完整的 XSS 过滤器，富文本场景请使用专业库（如 DOMPurify）在前端 + 服务端双重过滤
 * @param input 原始字符串
 * @returns 去标签后的字符串
 */
export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/**
 * 归一化空白字符。
 *
 * @description 把连续空白折叠成单个空格并去掉首尾空格。
 * 用户输入里的全角空格、换行、制表符会让「同样的地址」被判成两条不同记录
 * @param input 原始字符串
 * @returns 归一化后的字符串
 */
export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * 清洗纯文本：去标签 → 归一化空白。
 *
 * @param input 原始字符串
 * @returns 清洗后的字符串
 */
export function sanitizeText(input: string): string {
  return normalizeWhitespace(stripHtml(input));
}

/**
 * 去空白并归一化，空字符串返回 null。
 *
 * @description 用于可选字段：把 `''` / `'   '` 统一成 `null`，
 * 避免库里同时存在 `''` 和 `null` 两种「空」导致查询漏数据
 * @param input 原始值
 * @returns 清洗后的字符串或 null
 */
export function trimToNull(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = normalizeWhitespace(input);
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 转义 SQL LIKE 通配符。
 *
 * 为什么要转义：`LIKE` 里的 `%` 与 `_` 是通配符，用户搜索 `100%` 会命中所有以 100 开头的记录，
 * 既是正确性问题，也是拖垮数据库的性能问题（全表扫描）。
 * 配合 `Prisma.sql` 使用：`LIKE ${'%' + escapeLike(keyword) + '%'}`
 *
 * @param input 原始关键字
 * @returns 转义后的关键字
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * 归一化手机号（去空格、横线、+86 前缀）。
 *
 * @param input 原始输入
 * @returns 归一化后的手机号；无法识别时返回 null
 */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const digits = input.replace(/\D/g, '');
  const normalized = digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits;
  return /^1[3-9]\d{9}$/.test(normalized) ? normalized : null;
}

/**
 * 截断超长字符串。
 *
 * @description 防御性措施：日志与审计快照写入前截断，避免单个字段撑爆日志行
 * @param input 原始字符串
 * @param maxLength 最大长度
 * @returns 截断后的字符串
 */
export function truncate(input: string, maxLength: number): string {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength)}…`;
}
