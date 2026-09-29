import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createdUsers: [] as Array<Record<string, unknown>>,
  oauthLinks: [] as Array<Record<string, unknown>>,
  teamAdds: [] as Array<Record<string, unknown>>,
  auditCalls: [] as Array<unknown[]>,
  takenUsernames: new Set<string>(),
  teamById: new Map<number, { id: number; name: string }>(),
  allTeams: [] as Array<{ id: number; name: string }>,
  departmentNames: [] as string[],
  departmentError: null as Error | null,
}));

vi.mock('../db/bal/business-adapter', () => ({
  default: {},
  UserOperations: {
    getByUsername: vi.fn(async (username: string) => (mocks.takenUsernames.has(username) ? { id: 1, username } : undefined)),
    create: vi.fn(async (data: Record<string, unknown>) => {
      mocks.createdUsers.push(data);
      return mocks.createdUsers.length;
    }),
    getPublicById: vi.fn(),
  },
  OAuthOperations: {
    create: vi.fn(async (userId: number, provider: string, subject: string, email: string) => {
      mocks.oauthLinks.push({ userId, provider, subject, email });
    }),
  },
  TeamOperations: {
    addMember: vi.fn(async (teamId: number, userId: number, role: string) => {
      mocks.teamAdds.push({ teamId, userId, role });
    }),
    getById: vi.fn(async (teamId: number) => mocks.teamById.get(teamId)),
    getAll: vi.fn(async () => mocks.allTeams),
  },
  SettingsOperations: {},
  TwoFAOperations: {},
  UserPreferencesOperations: {},
  DomainOperations: {},
}));

vi.mock('./feishu-contacts', () => ({
  getFeishuUserDepartmentNames: vi.fn(async (_appId: string, _appSecret: string, openId: string) => {
    if (mocks.departmentError) throw mocks.departmentError;
    if (openId === 'ou_empty') return [];
    return [...mocks.departmentNames];
  }),
}));

vi.mock('./audit', () => ({
  logAuditOperation: vi.fn(async (...args: unknown[]) => {
    mocks.auditCalls.push(args);
  }),
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => {
    const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sub: () => stub };
    return stub;
  },
}));

import {
  deriveUsernameCandidates,
  provisionOAuthUser,
  resolveUniqueUsername,
  sanitizeUsernameCandidate,
} from './oauth-provision';

beforeEach(() => {
  mocks.createdUsers.length = 0;
  mocks.oauthLinks.length = 0;
  mocks.teamAdds.length = 0;
  mocks.auditCalls.length = 0;
  mocks.takenUsernames.clear();
  mocks.teamById.clear();
  mocks.allTeams.length = 0;
  mocks.departmentNames.length = 0;
  mocks.departmentError = null;
});

describe('sanitizeUsernameCandidate', () => {
  it('collapses invalid characters into underscores', () => {
    expect(sanitizeUsernameCandidate('zhang.san+test')).toBe('zhang_san_test');
  });

  it('strips leading/trailing separators and collapses repeats', () => {
    expect(sanitizeUsernameCandidate('__foo--bar__')).toBe('foo-bar');
  });

  it('drops non-latin characters', () => {
    expect(sanitizeUsernameCandidate('袁旗')).toBe('');
    expect(sanitizeUsernameCandidate('袁qi')).toBe('qi');
  });

  it('clamps length to 32', () => {
    expect(sanitizeUsernameCandidate('a'.repeat(50)).length).toBe(32);
  });
});

describe('deriveUsernameCandidates', () => {
  it('prefers email local part, then profile fields, then provider+subject fallback', () => {
    const candidates = deriveUsernameCandidates(
      'yuanqi@suanleme.cn',
      { sub: 'ou_d658e00978b46ee5391f78482d8019e1', preferred_username: 'yuanqi202606', name: '袁旗' },
      'feishu'
    );
    expect(candidates[0]).toBe('yuanqi');
    expect(candidates).toContain('yuanqi202606');
    // 中文名称被过滤，兜底使用 provider+subject 前缀
    expect(candidates).toContain('feishu_ou_d658e00978b46');
    expect(candidates).not.toContain('袁旗');
  });

  it('deduplicates candidates', () => {
    const candidates = deriveUsernameCandidates('foo@bar.com', { preferred_username: 'foo' }, 'oidc');
    expect(candidates.filter((c) => c === 'foo')).toHaveLength(1);
  });

  it('falls back to provider+subject when email/profile unusable', () => {
    const candidates = deriveUsernameCandidates('', { sub: 'abc123' }, 'casdoor');
    expect(candidates).toEqual(['casdoor_abc123']);
  });
});

describe('resolveUniqueUsername', () => {
  it('appends a numeric suffix to the first candidate when taken', async () => {
    const taken = async (name: string) => name === 'foo';
    await expect(resolveUniqueUsername(['foo', 'bar'], taken)).resolves.toBe('foo-2');
  });

  it('falls back to a later candidate only after exhausting suffixes', async () => {
    const taken = async (name: string) => name.startsWith('foo');
    await expect(resolveUniqueUsername(['foo', 'bar'], taken)).resolves.toBe('bar');
  });

  it('appends numeric suffix on collision and respects the 32-char limit', async () => {
    mocks.takenUsernames.add('foo');
    mocks.takenUsernames.add('foo-2');
    await expect(
      resolveUniqueUsername(['foo'], async (name) => mocks.takenUsernames.has(name))
    ).resolves.toBe('foo-3');
  });

  it('truncates base when suffix would exceed 32 chars', async () => {
    const base = 'a'.repeat(32);
    mocks.takenUsernames.add(base);
    const result = await resolveUniqueUsername([base], async (name) => mocks.takenUsernames.has(name));
    expect(result).toBe(`${'a'.repeat(30)}-2`);
    expect(result.length).toBe(32);
  });

  it('throws when everything is taken', async () => {
    await expect(resolveUniqueUsername(['foo'], async () => true)).rejects.toThrow(
      /unique username/
    );
  });
});

describe('provisionOAuthUser', () => {
  const baseOptions = {
    provider: 'feishu',
    subject: 'ou_d658e00978b46ee5391f78482d8019e1',
    email: 'yuanqi@suanleme.cn',
    profile: { sub: 'ou_d658e00978b46ee5391f78482d8019e1', name: '袁旗', preferred_username: 'yuanqi202606' },
    defaultRole: 1,
  };

  it('creates a member user with random password and binds the oauth identity', async () => {
    const result = await provisionOAuthUser(baseOptions);

    expect(result.userId).toBe(1);
    expect(result.username).toBe('yuanqi');
    expect(mocks.createdUsers).toHaveLength(1);
    const created = mocks.createdUsers[0];
    expect(created.username).toBe('yuanqi');
    expect(created.nickname).toBe('袁旗');
    expect(created.email).toBe('yuanqi@suanleme.cn');
    expect(created.role).toBe('member');
    expect(created.role_level).toBe(1);
    // bcrypt 随机不可用密码
    expect(String(created.password_hash)).toMatch(/^\$2[aby]\$/);

    expect(mocks.oauthLinks).toEqual([
      { userId: 1, provider: 'feishu', subject: 'ou_d658e00978b46ee5391f78482d8019e1', email: 'yuanqi@suanleme.cn' },
    ]);
    expect(mocks.teamAdds).toEqual([]);
    expect(mocks.auditCalls).toHaveLength(1);
    expect(mocks.auditCalls[0][1]).toBe('oauth_auto_provision');
    expect(mocks.auditCalls[0][3]).toMatchObject({ teamMode: 'none', teams: [] });
  });

  it('honors defaultRole=2 as admin but degrades super admin to member', async () => {
    await provisionOAuthUser({ ...baseOptions, defaultRole: 2 });
    expect(mocks.createdUsers[0].role).toBe('admin');
    expect(mocks.createdUsers[0].role_level).toBe(2);

    mocks.createdUsers.length = 0;
    await provisionOAuthUser({ ...baseOptions, defaultRole: 3 });
    expect(mocks.createdUsers[0].role).toBe('member');
    expect(mocks.createdUsers[0].role_level).toBe(1);
  });

  it('adds the user to the fixed team as member (teamPolicy mode=fixed)', async () => {
    mocks.teamById.set(7, { id: 7, name: '运维组' });
    const result = await provisionOAuthUser({
      ...baseOptions,
      teamPolicy: { mode: 'fixed', fixedTeamId: 7, feishuAppId: '', feishuAppSecret: '' },
    });
    expect(mocks.teamAdds).toEqual([{ teamId: 7, userId: 1, role: 'member' }]);
    expect(result.joinedTeams).toEqual(['运维组']);
    expect(mocks.auditCalls[0][3]).toMatchObject({ teamMode: 'fixed', teams: ['运维组'] });
  });

  it('skips fixed team silently when the team no longer exists', async () => {
    const result = await provisionOAuthUser({
      ...baseOptions,
      teamPolicy: { mode: 'fixed', fixedTeamId: 99, feishuAppId: '', feishuAppSecret: '' },
    });
    expect(mocks.teamAdds).toEqual([]);
    expect(result.joinedTeams).toEqual([]);
    expect(mocks.oauthLinks).toHaveLength(1);
  });

  it('does not let a failing team membership break provisioning', async () => {
    mocks.teamById.set(9, { id: 9, name: '九号团队' });
    const { TeamOperations } = await import('../db/bal/business-adapter');
    (TeamOperations.addMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('team gone'));
    await expect(
      provisionOAuthUser({
        ...baseOptions,
        teamPolicy: { mode: 'fixed', fixedTeamId: 9, feishuAppId: '', feishuAppSecret: '' },
      })
    ).resolves.toMatchObject({ userId: 1 });
    expect(mocks.oauthLinks).toHaveLength(1);
    expect(mocks.auditCalls).toHaveLength(1);
  });

  it('joins the team whose name matches the Feishu department (case-insensitive, trimmed)', async () => {
    mocks.allTeams.push(
      { id: 3, name: '运维组' },
      { id: 4, name: 'Infrastructure' },
      { id: 5, name: '未匹配团队' }
    );
    mocks.departmentNames.push(' 运维组 ', 'infrastructure');
    const result = await provisionOAuthUser({
      ...baseOptions,
      teamPolicy: { mode: 'department', fixedTeamId: null, feishuAppId: 'cli_x', feishuAppSecret: 'sec' },
    });
    expect(mocks.teamAdds).toEqual([
      { teamId: 3, userId: 1, role: 'member' },
      { teamId: 4, userId: 1, role: 'member' },
    ]);
    expect(result.joinedTeams).toEqual(['运维组', 'Infrastructure']);
    expect(mocks.auditCalls[0][3]).toMatchObject({ teamMode: 'department', teams: ['运维组', 'Infrastructure'] });
  });

  it('joins no team when no team name matches the departments', async () => {
    mocks.allTeams.push({ id: 3, name: '运维组' });
    mocks.departmentNames.push('财务部');
    const result = await provisionOAuthUser({
      ...baseOptions,
      teamPolicy: { mode: 'department', fixedTeamId: null, feishuAppId: 'cli_x', feishuAppSecret: 'sec' },
    });
    expect(mocks.teamAdds).toEqual([]);
    expect(result.joinedTeams).toEqual([]);
  });

  it('joins no team when the user has no Feishu departments', async () => {
    const result = await provisionOAuthUser({
      ...baseOptions,
      subject: 'ou_empty',
      teamPolicy: { mode: 'department', fixedTeamId: null, feishuAppId: 'cli_x', feishuAppSecret: 'sec' },
    });
    expect(mocks.teamAdds).toEqual([]);
    expect(result.joinedTeams).toEqual([]);
  });

  it('falls back to no team when the Feishu API fails (e.g. missing contact permission)', async () => {
    mocks.allTeams.push({ id: 3, name: '运维组' });
    mocks.departmentNames.push('运维组');
    mocks.departmentError = new Error('Feishu API failed: code=99991672');
    const result = await provisionOAuthUser({
      ...baseOptions,
      teamPolicy: { mode: 'department', fixedTeamId: null, feishuAppId: 'cli_x', feishuAppSecret: 'sec' },
    });
    // 建户仍成功，只是不归属团队
    expect(result.userId).toBe(1);
    expect(mocks.teamAdds).toEqual([]);
    expect(result.joinedTeams).toEqual([]);
    expect(mocks.oauthLinks).toHaveLength(1);
    expect(mocks.auditCalls).toHaveLength(1);
    expect(mocks.auditCalls[0][3]).toMatchObject({ teamMode: 'department', teams: [] });
  });

  it('resolves username collisions with a numeric suffix', async () => {
    mocks.takenUsernames.add('yuanqi');
    const result = await provisionOAuthUser(baseOptions);
    expect(result.username).toBe('yuanqi-2');
  });

  it('falls back to preferred_username when email local part is too short', async () => {
    const result = await provisionOAuthUser({ ...baseOptions, email: 'ab@suanleme.cn' });
    expect(result.username).toBe('yuanqi202606');
  });
});
