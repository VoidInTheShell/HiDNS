/**
 * OAuth 用户自动开户（JIT Provisioning）
 *
 * 当 OAuth 登录回调找不到已绑定账号且配置开启了 autoRegister 时，
 * 自动创建本地用户并完成 OAuth 绑定，并按团队策略加入默认团队：
 *   - none      不加入任何团队
 *   - fixed     加入 defaultTeamId 指定的固定团队
 *   - department 查询用户飞书部门，部门名与 HiDNS 团队名一致（忽略大小写）时加入该团队
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { createLogger } from '../lib/logger';
import { logAuditOperation } from './audit';
import { UserOperations, OAuthOperations, TeamOperations } from '../db/bal/business-adapter';
import { getFeishuUserDepartmentNames } from './feishu-contacts';

const log = createLogger('Auth').sub('OAuthProvision');

/** 与 server/src/utils/validation.ts 的 isValidUsername 保持一致：3-32 位字母/数字/_/- */
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

/** 将任意字符串清洗为候选用户名：非法字符折叠为下划线、连续分隔符去重、去首尾分隔符、截断到 32 位 */
export function sanitizeUsernameCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/[_-]+/g, (m) => m[0])
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 32);
}

/**
 * 生成候选用户名列表（按优先级去重）：
 * 1. 邮箱本地部分
 * 2. userinfo 中的 preferred_username / username / login / name / nickname
 * 3. 兜底：<provider>_<subject 前缀>
 */
export function deriveUsernameCandidates(
  email: string,
  profile: Record<string, unknown>,
  providerKey: string
): string[] {
  const candidates: string[] = [];
  const push = (raw: unknown) => {
    const value = typeof raw === 'string' ? sanitizeUsernameCandidate(raw) : '';
    if (USERNAME_RE.test(value) && !candidates.includes(value)) candidates.push(value);
  };

  if (email.includes('@')) {
    push(email.split('@')[0]);
  }
  for (const key of ['preferred_username', 'username', 'login', 'name', 'nickname']) {
    push(profile[key]);
  }
  const subject = typeof profile.sub === 'string' ? profile.sub : '';
  push(`${providerKey}_${subject.slice(0, 16)}`);

  return candidates;
}

/**
 * 依次尝试候选用户名；若被占用则追加 -2/-3… 序号（保持总长 ≤ 32）。
 * 每个候选最多尝试 100 次，全部失败抛出异常。
 */
export async function resolveUniqueUsername(
  candidates: string[],
  isTaken: (username: string) => Promise<boolean>
): Promise<string> {
  const bases = candidates.filter((c) => USERNAME_RE.test(c));
  if (bases.length === 0) bases.push('oauth_user');

  for (const base of bases) {
    if (!(await isTaken(base))) return base;
    for (let i = 2; i <= 100; i++) {
      const suffix = `-${i}`;
      const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
      if (!(await isTaken(candidate))) return candidate;
    }
  }
  throw new Error('Unable to generate a unique username for the new OAuth user');
}

/** 新用户默认团队策略 */
export interface OAuthProvisionTeamPolicy {
  /** none=不加入；fixed=加入 fixedTeamId；department=按飞书部门名匹配团队 */
  mode: 'none' | 'fixed' | 'department';
  /** mode=fixed 时加入的团队 ID */
  fixedTeamId: number | null;
  /** mode=department 时查询飞书通讯录使用的应用凭据 */
  feishuAppId: string;
  feishuAppSecret: string;
}

export interface OAuthProvisionOptions {
  /** OAuth 配置派生的 provider 键（providerName 小写） */
  provider: string;
  /** IdP 返回的唯一主体标识（飞书登录时为 open_id，ou_ 开头） */
  subject: string;
  /** 规范化后的邮箱（可能为空串） */
  email: string;
  /** userinfo / id_token 合并后的 profile */
  profile: Record<string, unknown>;
  /** 新用户角色级别：1=member（默认），2=admin；更高值一律降级为 member */
  defaultRole: number;
  /** 新用户默认团队策略（缺省为不加入） */
  teamPolicy?: OAuthProvisionTeamPolicy;
}

export interface OAuthProvisionResult {
  userId: number;
  username: string;
  roleLevel: number;
  /** 实际加入的团队名称列表（用于审计） */
  joinedTeams: string[];
}

/** 部门名与团队名的匹配规则：去首尾空白后忽略大小写比较 */
function isTeamNameMatched(teamName: string, departmentName: string): boolean {
  return teamName.trim().toLowerCase() === departmentName.trim().toLowerCase();
}

/**
 * 执行团队策略，返回实际加入的团队名称列表。
 * 任何失败（飞书 API 无权限、团队不存在、重复加团）都只记录告警，不阻断登录。
 */
async function applyTeamPolicy(userId: number, subject: string, policy: OAuthProvisionTeamPolicy): Promise<string[]> {
  if (policy.mode === 'none') return [];

  if (policy.mode === 'fixed') {
    const teamId = typeof policy.fixedTeamId === 'number' && policy.fixedTeamId > 0 ? policy.fixedTeamId : null;
    if (teamId === null) return [];
    try {
      const team = await TeamOperations.getById(teamId);
      if (!team) {
        log.warn('Default team no longer exists', { teamId, userId });
        return [];
      }
      await TeamOperations.addMember(teamId, userId, 'member');
      return [String(team.name || teamId)];
    } catch (error) {
      log.warn('Failed to add provisioned user to fixed team', {
        teamId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // mode === 'department'：按飞书部门名匹配团队名
  try {
    const departmentNames = await getFeishuUserDepartmentNames(policy.feishuAppId, policy.feishuAppSecret, subject);
    if (departmentNames.length === 0) {
      log.info('Provisioned user has no matching Feishu departments, skipping team assignment', { userId });
      return [];
    }
    const teams = await TeamOperations.getAll();
    const joined: string[] = [];
    for (const departmentName of departmentNames) {
      const team = teams.find((tm) => typeof tm.name === 'string' && isTeamNameMatched(tm.name, departmentName));
      if (!team) continue;
      try {
        await TeamOperations.addMember(Number(team.id), userId, 'member');
        joined.push(String(team.name));
      } catch (error) {
        // 用户可能已在团队中（并发回调等），仅告警
        log.warn('Failed to add provisioned user to matched team', {
          teamId: team.id,
          teamName: team.name,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (joined.length === 0) {
      log.info('No HiDNS team name matches Feishu departments', { userId, departments: departmentNames });
    }
    return joined;
  } catch (error) {
    // 常见原因：飞书应用未开通通讯录组织架构读取权限
    log.warn('Feishu department lookup failed, skipping team assignment', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * JIT 建户：创建本地用户（随机不可用密码）+ 写入 OAuth 绑定 +
 * 按团队策略加入默认团队，并记录 oauth_auto_provision 审计日志。
 *
 * 团队分配失败不应阻断登录，仅记录告警。
 */
export async function provisionOAuthUser(options: OAuthProvisionOptions): Promise<OAuthProvisionResult> {
  const { provider, subject, email, profile, defaultRole, teamPolicy } = options;

  const candidates = deriveUsernameCandidates(email, profile, provider);
  const username = await resolveUniqueUsername(candidates, async (name) => {
    const existing = await UserOperations.getByUsername(name);
    return Boolean(existing);
  });

  // 禁止自动创建管理员以外的更高角色：仅 defaultRole===2 时为 admin，其余（含超管）降级为 member
  const roleLevel = defaultRole === 2 ? 2 : 1;
  const roleText = roleLevel >= 2 ? 'admin' : 'member';

  // OAuth 建户用户没有本地密码：写入随机不可用密码，防止空密码/弱口令登录
  const randomPassword = crypto.randomBytes(48).toString('hex');
  const passwordHash = bcrypt.hashSync(randomPassword, 10);

  const nicknameSource = [profile.name, profile.nickname, profile.display_name, profile.given_name]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean);
  const nickname = (nicknameSource || username).slice(0, 100);

  const userId = await UserOperations.create({
    username,
    nickname,
    email,
    password_hash: passwordHash,
    role: roleText,
    role_level: roleLevel,
  });

  await OAuthOperations.create(userId, provider, subject, email);

  const joinedTeams = await applyTeamPolicy(userId, subject, teamPolicy || { mode: 'none', fixedTeamId: null, feishuAppId: '', feishuAppSecret: '' });

  await logAuditOperation(userId, 'oauth_auto_provision', 'system', {
    provider,
    subject,
    email,
    username,
    role: roleLevel,
    teamMode: teamPolicy?.mode || 'none',
    teams: joinedTeams,
  });

  log.info('OAuth user auto-provisioned', { userId, username, provider, role: roleLevel, teams: joinedTeams });

  return { userId, username, roleLevel, joinedTeams };
}
