import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => {
    const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sub: () => stub };
    return stub;
  },
}));

import { getFeishuAppAccessToken, getFeishuUserDepartmentNames } from './feishu-contacts';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  mocks.fetchMock.mockReset();
  vi.stubGlobal('fetch', mocks.fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getFeishuAppAccessToken', () => {
  it('posts credentials to the internal token endpoint and returns the token', async () => {
    mocks.fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 0, msg: 'ok', data: { app_access_token: 't-'.repeat(4) + 'x' } })
    );
    const token = await getFeishuAppAccessToken('cli_app', 'secret');
    expect(token).toBe('t-t-t-t-x');

    const [url, init] = mocks.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ app_id: 'cli_app', app_secret: 'secret' });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws when the API returns a non-zero code', async () => {
    mocks.fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 99991663, msg: 'app secret invalid' })
    );
    await expect(getFeishuAppAccessToken('cli_app', 'bad')).rejects.toThrow(/code=99991663.*app secret invalid/);
  });

  it('throws when the token is empty', async () => {
    mocks.fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 0, msg: 'ok', data: { app_access_token: '' } })
    );
    await expect(getFeishuAppAccessToken('cli_app', 'secret')).rejects.toThrow(/empty/);
  });
});

describe('getFeishuUserDepartmentNames', () => {
  it('fetches the user, then batch-resolves department names with dedup', async () => {
    mocks.fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, msg: 'ok', data: { app_access_token: 'token' } })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          msg: 'success',
          data: { user: { open_id: 'ou_abc', department_ids: ['od-1', 'od-2', 'od-2'] } },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          msg: 'success',
          data: { departments: [{ open_department_id: 'od-1', name: ' 运维组 ' }, { open_department_id: 'od-2', name: '运维组' }] },
        })
      );

    const names = await getFeishuUserDepartmentNames('cli_app', 'secret', 'ou_abc');
    expect(names).toEqual(['运维组']);

    // 用户查询带 token 与查询参数
    const userCall = mocks.fetchMock.mock.calls[1] as [string, RequestInit];
    expect(userCall[0]).toBe(
      'https://open.feishu.cn/open-apis/contact/v3/users/ou_abc?user_id_type=open_id&department_id_type=open_department_id'
    );
    expect((userCall[1].headers as Record<string, string>).Authorization).toBe('Bearer token');

    // 部门批量查询
    const deptCall = mocks.fetchMock.mock.calls[2] as [string, RequestInit];
    expect(deptCall[0]).toBe(
      'https://open.feishu.cn/open-apis/contact/v3/departments/batch_get?department_id_type=open_department_id&user_id_type=open_id'
    );
    expect(JSON.parse(String(deptCall[1].body))).toEqual({ department_ids: ['od-1', 'od-2', 'od-2'] });
  });

  it('returns an empty list when the user has no departments', async () => {
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: { app_access_token: 'token' } }))
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, msg: 'success', data: { user: { open_id: 'ou_abc', department_ids: [] } } })
      );
    const names = await getFeishuUserDepartmentNames('cli_app', 'secret', 'ou_abc');
    expect(names).toEqual([]);
    expect(mocks.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws with the API error when the user lookup fails (e.g. missing permission)', async () => {
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: { app_access_token: 'token' } }))
      .mockResolvedValueOnce(
        jsonResponse({ code: 99991672, msg: 'no permission' })
      );
    await expect(getFeishuUserDepartmentNames('cli_app', 'secret', 'ou_abc')).rejects.toThrow(
      /code=99991672.*no permission/
    );
  });

  it('propagates HTTP-level failures', async () => {
    mocks.fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 0, msg: 'ok', data: {} }, 502)
    );
    await expect(getFeishuAppAccessToken('cli_app', 'secret')).rejects.toThrow(/HTTP 502/);
  });
});
