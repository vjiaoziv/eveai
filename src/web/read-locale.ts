import type { FastifyRequest } from 'fastify';

/**
 * Response locale for map/advisory routes (i18n Unification plan, decision
 * B): the browser's Accept-Language first tag decides, and unknown or
 * missing values fall back to ru so existing Russian deployments behave
 * exactly as before (plan risks R1 / decision Q1).
 */
export function readLocale(request: FastifyRequest): 'zh' | 'ru' | 'en' {
  const header = request.headers['accept-language'];
  if (typeof header === 'string') {
    // 只取第一个声明的语言：`en-US,en;q=0.9,zh-CN;q=0.8` 应保持 en。
    const first = header.split(',')[0]?.trim().toLowerCase() ?? '';
    if (first.startsWith('zh')) return 'zh';
    if (first.startsWith('en')) return 'en';
  }
  // 未知语言不改变存量俄语部署的默认行为（计划 R1/Q1）。
  return 'ru';
}