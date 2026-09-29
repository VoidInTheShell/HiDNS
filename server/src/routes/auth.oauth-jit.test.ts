/**
 * OAuth 回调 JIT 自动建户分支的路由级测试
 * 覆盖：autoRegister 开启时自动建户并登录 / 关闭时维持 403 / 已绑定用户正常登录
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

const mocks = vi.hoisted(() => ({
  auditCalls: [] as Array<{ userId: number; action: string; data: Record<string, unknown> }>,
  createdUsers: [] as Array<Record<string, unknown>>,
  oauthLinks: [] as Array<Record<string, unknown>>,
  teamAdds: [] as Array<Record<string, unknown>>,
  takenUsernames: new Set<string>(),
  existingLink: undefined as Record<string, unknown> | undefined,
  oauthConfig: {} as Record<string, unknown>,
}));

vi.mock('../db/bal/business-adapter', () => ({
  default: {},
  UserOperations: {
    getByUsername: vi.fn(async (username: string) => (mocks.takenUsernames.has(username) ? { id: 1, username } : undefined)),
    create: vi.fn(async (data: Record<string, unknown>) => {
      mocks.createdUsers.push(data);
      return 100 + mocks.createdUsers.length;
    }),
    getPublicById: vi.fn(async (id: number) => ({
      id,
      username: 'newuser',
      nickname: 'New User',
      email: 'newuser@example.com',
      role_level: 1,
      status: 1,
    })),
  },
  OAuthOperations: {
    getAndDeleteState: vi.fn(async () => ({
      state: 'state-jit',
      mode: 'login',
      provider: 'custom',
      userId: null,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    })),
    getUserByProviderSubject: vi.fn(async () => mocks.existingLink),
    createState: vi.fn(),
    create: vi.fn(async (userId: number, provider: string, subject: string, email: string) => {
      mocks.oauthLinks.push({ userId, provider, subject, email });
    }),
    getByUserId: vi.fn(),
    delete: vi.fn(),
  },
  TeamOperations: {
    addMember: vi.fn(async (teamId: number, userId: number, role: string) => {
      mocks.teamAdds.push({ teamId, userId, role });
    }),
    getById: vi.fn(async (teamId: number) => ({ id: teamId, name: `team-${teamId}` })),
  },
  SettingsOperations: {
    get: vi.fn(async (key: string) => (key === 'oauth_config' ? JSON.stringify(mocks.oauthConfig) : undefined)),
  },
  TwoFAOperations: {},
  UserPreferencesOperations: {},
  DomainOperations: {},
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { userId: 1, role: 3 };
    next();
  },
  adminOnly: (_req: any, _res: any, next: any) => next(),
  noTokenAuth: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../service/jwt', () => ({ signToken: vi.fn(async () => 'test-token') }));
vi.mock('../service/loginLimit', () => ({
  checkLoginAllowed: vi.fn(async () => true),
  recordFailedAttempt: vi.fn(),
  clearLoginAttempts: vi.fn(),
}));
vi.mock('../service/emailVerification', () => ({
  sendEmailVerificationCode: vi.fn(),
  verifyEmailVerificationCode: vi.fn(),
}));
vi.mock('../service/audit', () => ({
  logAuditOperation: vi.fn(async (userId: number, action: string, _domain: string, data: Record<string, unknown>) => {
    mocks.auditCalls.push({ userId, action, data });
  }),
}));
vi.mock('../service/smtp', () => ({
  getSmtpConfig: vi.fn(),
  sendSmtpEmail: vi.fn(),
}));
vi.mock('../service/userPreferences', () => ({
  getUserPreferences: vi.fn(),
  updateUserPreferences: vi.fn(),
}));
vi.mock('../service/totp', () => ({
  getTOTPStatus: vi.fn(),
  verifyTOTPToken: vi.fn(),
  verifyBackupCode: vi.fn(),
}));
vi.mock('../service/securityPolicy', () => ({
  requires2FA: vi.fn(),
  has2FAEnabled: vi.fn(),
  validatePassword: vi.fn(),
  getSecurityPolicy: vi.fn(),
}));
vi.mock('../service/deviceTrust', () => ({
  verifyTrustedDevice: vi.fn(),
  addTrustedDevice: vi.fn(),
}));
vi.mock('../middleware/rateLimit', () => ({
  loginLimiter: (_req: any, _res: any, next: any) => next(),
  emailLimiter: (_req: any, _res: any, next: any) => next(),
}));

import authRouter from './auth';

const BASE_OAUTH_CONFIG = {
  enabled: true,
  template: 'generic',
  providerName: 'feishu',
  subjectKey: 'sub',
  emailKey: 'email',
  logtoDomain: '',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  issuer: 'https://idp.example.com',
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token',
  userInfoEndpoint: 'https://idp.example.com/userinfo',
  jwksUri: 'https://idp.example.com/jwks',
  scopes: 'openid profile email',
  redirectUri: 'https://hidnsl.example.com/oauth/callback',
  providerHint: 'feishu',
};

let server: Server;
let baseURL: string;

beforeAll(async () => {
  const realFetch = globalThis.fetch.bind(globalThis);
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      // 测试自身发往本地 express 的请求，放行真实 fetch
      return realFetch(input as RequestInfo, init as RequestInit);
    }
    if (url.includes('/token')) {
      return json({ access_token: 'stub-access-token' });
    }
    if (url.includes('/userinfo')) {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer stub-access-token');
      return json({
        sub: 'ou_newuser123',
        email: 'newuser@example.com',
        name: 'New User',
        preferred_username: 'newuser',
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mocks.auditCalls.length = 0;
  mocks.createdUsers.length = 0;
  mocks.oauthLinks.length = 0;
  mocks.teamAdds.length = 0;
  mocks.takenUsernames.clear();
  mocks.existingLink = undefined;
  mocks.oauthConfig = { ...BASE_OAUTH_CONFIG };
});

describe('POST /api/auth/oauth/callback JIT provisioning', () => {
  it('auto-creates and logs in an unbound user when autoRegister is enabled', async () => {
    mocks.oauthConfig = { ...BASE_OAUTH_CONFIG, autoRegister: true, defaultRole: 1, defaultTeamId: 5 };

    const response = await fetch(`${baseURL}/api/auth/oauth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'code-jit-1', state: 'state-jit' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: number; data: { mode: string; user: Record<string, unknown> } };
    expect(body.code).toBe(0);
    expect(body.data.mode).toBe('login');
    expect(body.data.user.id).toBe(101);
    expect(body.data.user.username).toBe('newuser');

    // 建户参数：member 角色、邮箱、昵称
    expect(mocks.createdUsers).toHaveLength(1);
    expect(mocks.createdUsers[0]).toMatchObject({
      username: 'newuser',
      nickname: 'New User',
      email: 'newuser@example.com',
      role: 'member',
      role_level: 1,
    });
    // OAuth 绑定
    expect(mocks.oauthLinks).toEqual([
      { userId: 101, provider: 'feishu', subject: 'ou_newuser123', email: 'newuser@example.com' },
    ]);
    // 默认团队
    expect(mocks.teamAdds).toEqual([{ teamId: 5, userId: 101, role: 'member' }]);
    // 审计：先建户后登录
    const actions = mocks.auditCalls.map((c) => c.action);
    expect(actions).toContain('oauth_auto_provision');
    expect(actions).toContain('oauth_login');
    // 登录 cookie 已设置
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('token=test-token');
  });

  it('keeps returning 403 for unbound users when autoRegister is disabled', async () => {
    mocks.oauthConfig = { ...BASE_OAUTH_CONFIG, autoRegister: false };

    const response = await fetch(`${baseURL}/api/auth/oauth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'code-jit-2', state: 'state-jit' }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: number; msg: string };
    expect(body.msg).toContain('not bound');
    expect(mocks.createdUsers).toHaveLength(0);
  });

  it('logs in an already-bound user without provisioning', async () => {
    mocks.existingLink = {
      user_id: 7,
      id: 7,
      username: 'bounduser',
      nickname: 'Bound',
      email: 'bound@example.com',
      role: 1,
      status: 1,
    };

    const response = await fetch(`${baseURL}/api/auth/oauth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'code-jit-3', state: 'state-jit' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: number; data: { user: Record<string, unknown> } };
    expect(body.code).toBe(0);
    expect(body.data.user.id).toBe(7);
    expect(mocks.createdUsers).toHaveLength(0);
    expect(mocks.auditCalls.map((c) => c.action)).toEqual(['oauth_login']);
  });
});
