/**
 * OAuth 用户自动开户（JIT Provisioning）
 *
 * 当 OAuth 登录回调找不到已绑定账号且配置开启了 autoRegister 时，
 * 自动创建本地用户并完成 OAuth 绑定，可选将其加入默认团队。
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { createLogger } from '../lib/logger';
import { logAuditOperation } from './audit';
import { UserOperations, OAuthOperations, TeamOperations } from '../db/bal/business-adapter';

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

export interface OAuthProvisionOptions {
  /** OAuth 配置派生的 provider 键（providerName 小写） */
  provider: string;
  /** IdP 返回的唯一主体标识 */
  subject: string;
  /** 规范化后的邮箱（可能为空串） */
  email: string;
  /** userinfo / id_token 合并后的 profile */
  profile: Record<string, unknown>;
  /** 新用户角色级别：1=member（默认），2=admin；更高值一律降级为 member */
  defaultRole: number;
  /** 新用户自动加入的团队 ID（null/0 表示不加入） */
  defaultTeamId: number | null;
}

export interface OAuthProvisionResult {
  userId: number;
  username: string;
  roleLevel: number;
}

/**
 * JIT 建户：创建本地用户（随机不可用密码）+ 写入 OAuth 绑定 +
 * （可选）加入默认团队，并记录 oauth_auto_provision 审计日志。
 *
 * 默认团队失效不应阻断登录，仅记录告警。
 */
export async function provisionOAuthUser(options: OAuthProvisionOptions): Promise<OAuthProvisionResult> {
  const { provider, subject, email, profile, defaultRole, defaultTeamId } = options;

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

  const teamId = typeof defaultTeamId === 'number' && defaultTeamId > 0 ? defaultTeamId : null;
  if (teamId !== null) {
    try {
      await TeamOperations.addMember(teamId, userId, 'member');
    } catch (error) {
      // 默认团队可能已被删除或用户已在团队中：不阻断登录流程
      log.warn('Failed to add provisioned user to default team', {
        teamId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await logAuditOperation(userId, 'oauth_auto_provision', 'system', {
    provider,
    subject,
    email,
    username,
    role: roleLevel,
    teamId,
  });

  log.info('OAuth user auto-provisioned', { userId, username, provider, role: roleLevel, teamId });

  return { userId, username, roleLevel };
}
