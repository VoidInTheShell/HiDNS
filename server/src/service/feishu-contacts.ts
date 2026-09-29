/**
 * 飞书通讯录查询服务
 *
 * 用于 OAuth 自动建户时按「飞书部门名 ↔ HiDNS 团队名」匹配新用户的默认团队。
 * 使用飞书应用（App ID / App Secret，与 Casdoor 所配应用相同的凭据体系）：
 *   1. POST /open-apis/auth/v3/app_access_token/internal            → app_access_token
 *   2. GET  /open-apis/contact/v3/users/{open_id}                    → department_ids
 *   3. POST /open-apis/contact/v3/departments/batch_get              → 部门名称
 *
 * 应用需在飞书开放平台开通权限：
 *   - 获取用户组织架构信息（返回 department_ids）
 *   - 获取部门基本信息（返回部门名称）
 * 未开通时 API 返回错误，调用方应降级处理（告警并跳过团队分配）。
 */
import { createLogger } from '../lib/logger';

const log = createLogger('Auth').sub('FeishuContacts');

const FEISHU_API_BASE = 'https://open.feishu.cn';

interface FeishuResponse<T> {
  code: number;
  msg: string;
  data?: T;
}

async function feishuRequest<T>(path: string, init: RequestInit, token?: string): Promise<FeishuResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${FEISHU_API_BASE}${path}`, { ...init, headers });
  const payload = await response.json() as FeishuResponse<T>;
  if (!response.ok || payload.code !== 0) {
    throw new Error(`Feishu API ${path} failed: HTTP ${response.status}, code=${payload.code}, msg=${payload.msg}`);
  }
  return payload;
}

/** 获取飞书应用 app_access_token（有效期 2 小时，按次获取） */
export async function getFeishuAppAccessToken(appId: string, appSecret: string): Promise<string> {
  const payload = await feishuRequest<{ app_access_token: string }>(
    '/open-apis/auth/v3/app_access_token/internal',
    {
      method: 'POST',
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );
  const token = payload.data?.app_access_token || '';
  if (!token) throw new Error('Feishu app_access_token is empty');
  return token;
}

interface FeishuUser {
  open_id?: string;
  department_ids?: string[];
}

interface FeishuDepartment {
  open_department_id?: string;
  name?: string;
}

/**
 * 查询飞书用户所属部门的名称列表。
 *
 * @param appId     飞书应用 App ID
 * @param appSecret 飞书应用 App Secret
 * @param openId    用户 open_id（即 OAuth 登录回调中的 subject，ou_ 开头）
 * @returns 部门名称列表（去重、去空），用户无部门或查询失败时抛错/返回空
 */
export async function getFeishuUserDepartmentNames(appId: string, appSecret: string, openId: string): Promise<string[]> {
  const token = await getFeishuAppAccessToken(appId, appSecret);

  const userPayload = await feishuRequest<{ user?: FeishuUser }>(
    `/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id&department_id_type=open_department_id`,
    { method: 'GET' },
    token
  );
  const departmentIds = (userPayload.data?.user?.department_ids || []).filter(Boolean);
  if (departmentIds.length === 0) {
    log.info('Feishu user has no departments', { openId: openId.substring(0, 10) + '...' });
    return [];
  }

  const deptPayload = await feishuRequest<{ departments?: FeishuDepartment[] }>(
    '/open-apis/contact/v3/departments/batch_get?department_id_type=open_department_id&user_id_type=open_id',
    {
      method: 'POST',
      body: JSON.stringify({ department_ids: departmentIds }),
    },
    token
  );

  const names = (deptPayload.data?.departments || [])
    .map((d) => (d.name || '').trim())
    .filter(Boolean);
  return [...new Set(names)];
}
