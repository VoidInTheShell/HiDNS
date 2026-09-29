import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button, Card, Input, Select, Space, Switch } from 'tdesign-react';
import { BrowseIcon, BrowseOffIcon, CopyIcon, LockOnIcon, SecuredIcon, SettingIcon } from 'tdesign-icons-react';
import { settingsApi, teamsApi } from '../../api';
import { useToast } from '../../hooks/useToast';
import { useI18n } from '../../contexts/I18nContext';

const DEFAULT_OAUTH_FORM = {
  enabled: false,
  template: 'generic' as 'generic' | 'logto',
  providerName: 'default',
  subjectKey: 'sub',
  emailKey: 'email',
  logtoDomain: '',
  clientId: '',
  clientSecret: '',
  issuer: '',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  userInfoEndpoint: '',
  jwksUri: '',
  scopes: 'openid profile email',
  redirectUri: '',
  providerHint: '',
  autoRegister: false,
  defaultRole: 1,
  defaultTeamId: 0,
};

const DEFAULT_LOGTO_FORM = {
  enabled: false,
  template: 'logto' as 'generic' | 'logto',
  providerName: 'Logto',
  subjectKey: 'sub',
  emailKey: 'email',
  logtoDomain: '',
  clientId: '',
  clientSecret: '',
  issuer: '',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  userInfoEndpoint: '',
  jwksUri: '',
  scopes: 'openid profile email',
  redirectUri: '',
};

const accessField = (label: string, control: ReactNode) => (
  <div className="settings-control-field">
    <span>{label}</span>
    {control}
  </div>
);

/** 将服务端 OAuthConfig 合并进表单时规范化 JIT 字段（团队 null → 0 表示不加入） */
const mergeOauthForm = (
  prev: typeof DEFAULT_OAUTH_FORM,
  config: Partial<Omit<typeof DEFAULT_OAUTH_FORM, 'defaultTeamId'>> & { defaultTeamId?: number | null }
) => ({
  ...prev,
  ...config,
  autoRegister: config.autoRegister === true,
  defaultRole: Number(config.defaultRole) === 2 ? 2 : 1,
  defaultTeamId: Number(config.defaultTeamId) > 0 ? Number(config.defaultTeamId) : 0,
});

export function AccessTab() {
  const { t } = useI18n();
  const toast = useToast();

  const [showJwtSecret, setShowJwtSecret] = useState(false);
  const [jwtPassword, setJwtPassword] = useState('');
  const [jwtSecretValue, setJwtSecretValue] = useState('');

  const [oauthForm, setOauthForm] = useState(DEFAULT_OAUTH_FORM);
  const [logtoForm, setLogtoForm] = useState(DEFAULT_LOGTO_FORM);

  const { data: logtoConfig, dataUpdatedAt: logtoConfigUpdatedAt } = useQuery({
    queryKey: ['oauth-logto-config'],
    queryFn: async () => {
      const res = await settingsApi.getLogtoOAuthConfig();
      if (res.data.code === 0 && res.data.data) {
        return res.data.data;
      }
      throw new Error(res.data.msg);
    },
    staleTime: 0,
    refetchOnMount: 'always',
    gcTime: 0,
  });

  const { data: oauthConfig, dataUpdatedAt: oauthConfigUpdatedAt } = useQuery({
    queryKey: ['oauth-config'],
    queryFn: async () => {
      const res = await settingsApi.getOAuthConfig();
      if (res.data.code === 0 && res.data.data) {
        return res.data.data;
      }
      throw new Error(res.data.msg);
    },
    staleTime: 0,
    refetchOnMount: 'always',
    gcTime: 0,
  });

  useEffect(() => {
    if (!logtoConfig) return;
    setLogtoForm((prev) => ({ ...prev, ...logtoConfig }));
  }, [logtoConfig, logtoConfigUpdatedAt]);

  useEffect(() => {
    if (!oauthConfig) return;
    setOauthForm((prev) => mergeOauthForm(prev, oauthConfig));
  }, [oauthConfig, oauthConfigUpdatedAt]);

  const revealJwtSecretMutation = useMutation({
    mutationFn: (password: string) => settingsApi.getJwtSecret(password),
    onSuccess: (res) => {
      if (res.data.code === 0) {
        setJwtSecretValue(res.data.data.jwtSecret || '');
        setJwtPassword('');
        toast.success(t('system.jwtSecretVerified'));
      } else {
        toast.error(res.data.msg || t('system.jwtSecretVerifyFailed'));
      }
    },
    onError: (error: Error) => toast.error(error.message || t('system.jwtSecretVerifyFailed')),
  });

  const { data: teamList } = useQuery({
    queryKey: ['teams'],
    queryFn: async () => {
      const res = await teamsApi.list();
      if (res.data.code === 0 && res.data.data) {
        return res.data.data;
      }
      throw new Error(res.data.msg);
    },
  });

  const updateOauthMutation = useMutation({
    mutationFn: () => settingsApi.updateOAuthConfig({
      ...oauthForm,
      providerName: oauthForm.providerName.trim(),
      subjectKey: oauthForm.subjectKey.trim(),
      emailKey: oauthForm.emailKey.trim(),
      logtoDomain: oauthForm.logtoDomain.trim(),
      clientId: oauthForm.clientId.trim(),
      clientSecret: oauthForm.clientSecret.trim(),
      issuer: oauthForm.issuer.trim(),
      authorizationEndpoint: oauthForm.authorizationEndpoint.trim(),
      tokenEndpoint: oauthForm.tokenEndpoint.trim(),
      userInfoEndpoint: oauthForm.userInfoEndpoint.trim(),
      jwksUri: oauthForm.jwksUri.trim(),
      scopes: oauthForm.scopes.trim(),
      redirectUri: oauthForm.redirectUri.trim(),
      providerHint: oauthForm.providerHint.trim(),
      autoRegister: oauthForm.autoRegister === true,
      defaultRole: oauthForm.defaultRole === 2 ? 2 : 1,
      defaultTeamId: oauthForm.defaultTeamId > 0 ? oauthForm.defaultTeamId : null,
    }),
    onSuccess: (res) => {
      if (res.data.code !== 0) {
        toast.error(res.data.msg);
        return;
      }
      if (res.data.data) {
        setOauthForm((prev) => mergeOauthForm(prev, res.data.data!));
      }
      toast.success(t('system.oauthSaved'));
    },
    onError: (error: Error) => toast.error(error.message || t('system.oauthSaveFailed')),
  });

  const updateLogtoOauthMutation = useMutation({
    mutationFn: () => settingsApi.updateLogtoOAuthConfig({
      ...logtoForm,
      template: 'logto',
      providerName: logtoForm.providerName.trim(),
      subjectKey: logtoForm.subjectKey.trim(),
      emailKey: logtoForm.emailKey.trim(),
      logtoDomain: logtoForm.logtoDomain.trim(),
      clientId: logtoForm.clientId.trim(),
      clientSecret: logtoForm.clientSecret.trim(),
      redirectUri: logtoForm.redirectUri.trim(),
      scopes: logtoForm.scopes.trim(),
    }),
    onSuccess: (res) => {
      if (res.data.code !== 0) {
        toast.error(res.data.msg);
        return;
      }
      if (res.data.data) {
        setLogtoForm((prev) => ({ ...prev, ...res.data.data }));
      }
      toast.success(t('system.oauthSaved'));
    },
    onError: (error: Error) => toast.error(error.message || t('system.oauthSaveFailed')),
  });

  const discoverOidcMutation = useMutation({
    mutationFn: () => settingsApi.discoverOidc(oauthForm.issuer.trim()),
    onSuccess: (res) => {
      if (res.data.code !== 0 || !res.data.data) {
        toast.error(res.data.msg || t('system.oidcDiscoverFailed'));
        return;
      }
      // Sync the discovered config to the form
      setOauthForm((prev) => mergeOauthForm(prev, res.data.data!));
      toast.success(t('system.oidcDiscoverSuccess'));
    },
    onError: (error: Error) => toast.error(error.message || t('system.oidcDiscoverFailed')),
  });

  const handleVerifyAndRevealJwtSecret = () => {
    if (!jwtPassword.trim()) {
      toast.error(t('system.jwtPasswordRequired'));
      return;
    }
    revealJwtSecretMutation.mutate(jwtPassword.trim());
  };

  const handleCopyJwtSecret = async () => {
    if (!jwtSecretValue) {
      toast.error(t('system.jwtSecretEmpty'));
      return;
    }
    try {
      await navigator.clipboard.writeText(jwtSecretValue);
      toast.success(t('system.jwtSecretCopied'));
    } catch {
      toast.error(t('system.jwtSecretCopyFailed'));
    }
  };

  const redirectUri = `${window.location.origin}/oauth/callback`;
  const setOauthField = (key: keyof typeof oauthForm, value: string | boolean | number) => setOauthForm((form) => ({ ...form, [key]: value }));
  const setLogtoField = (key: keyof typeof logtoForm, value: string | boolean | number) => setLogtoForm((form) => ({ ...form, [key]: value }));

  return (
    <div className="access-grid">
      <Card bordered={false} shadow={false} title={<Space align="center"><LockOnIcon />{t('system.jwtSecret')}</Space>} subtitle={t('system.jwtSecretDesc')}>
        <div className="page-shell">
          <Space>
            <Input
              type="password"
              value={jwtPassword}
              onChange={(value: any) => setJwtPassword(String(value))}
              placeholder={t('system.jwtPasswordPlaceholder')}
            />
            <Button theme="primary" loading={revealJwtSecretMutation.isPending} onClick={handleVerifyAndRevealJwtSecret}>
              {t('system.verifyAndViewJwt')}
            </Button>
          </Space>
          <Space>
            <Input
              type={showJwtSecret ? 'text' : 'password'}
              readonly
              value={jwtSecretValue}
              placeholder={t('system.verifyAndViewJwt')}
            />
            <Button
              shape="square"
              variant="outline"
              icon={showJwtSecret ? <BrowseOffIcon /> : <BrowseIcon />}
              title={showJwtSecret ? t('system.hideJwtSecret') : t('system.showJwtSecret')}
              onClick={() => setShowJwtSecret((value) => !value)}
            />
            <Button shape="square" variant="outline" icon={<CopyIcon />} title={t('system.copyJwtSecret')} onClick={handleCopyJwtSecret} />
          </Space>
        </div>
      </Card>

      <Card bordered={false} shadow={false} title={<Space align="center"><SecuredIcon />{t('system.oauthConfig')}</Space>} subtitle={t('system.oauthConfigDesc')}>
        <div className="page-shell">
          <div className="access-form-grid">
            {accessField(t('system.oauthTemplateGeneric'), (
              <Select
                value={oauthForm.template}
                options={[
                  { label: t('system.oauthTemplateGeneric'), value: 'generic' },
                  { label: t('system.oauthTemplateLogto'), value: 'logto' },
                ]}
                onChange={(value: any) => setOauthField('template', String(Array.isArray(value) ? value[0] : value) as 'generic' | 'logto')}
              />
            ))}
            {accessField(t('system.oauthProvider'), (
              <Input
                value={String(oauthForm.providerName)}
                onChange={(value: any) => setOauthField('providerName', String(value))}
                placeholder={t('system.oauthProvider')}
              />
            ))}
            {accessField(t('system.oauthProviderHint'), (
              <Input
                value={String(oauthForm.providerHint)}
                onChange={(value: any) => setOauthField('providerHint', String(value))}
                placeholder={t('system.oauthProviderHintPlaceholder')}
              />
            ))}
            {oauthForm.template === 'logto' && accessField(t('system.oauthLogtoDomain'), (
                <Input
                  value={String(oauthForm.logtoDomain)}
                  onChange={(value: any) => setOauthField('logtoDomain', String(value))}
                  placeholder={t('system.oauthLogtoDomain')}
                />
            ))}
            {accessField(t('system.oauthIssuer'), (
              <Input
                value={String(oauthForm.issuer)}
                onChange={(value: any) => setOauthField('issuer', String(value))}
                placeholder={t('system.oauthIssuer')}
              />
            ))}
            {accessField(t('system.oauthSubjectKey'), (
              <Input
                value={String(oauthForm.subjectKey)}
                onChange={(value: any) => setOauthField('subjectKey', String(value))}
                placeholder={t('system.oauthSubjectKey')}
              />
            ))}
            {accessField(t('system.oauthEmailKey'), (
              <Input
                value={String(oauthForm.emailKey)}
                onChange={(value: any) => setOauthField('emailKey', String(value))}
                placeholder={t('system.oauthEmailKey')}
              />
            ))}
            {accessField(t('system.oauthClientId'), (
              <Input
                value={String(oauthForm.clientId)}
                onChange={(value: any) => setOauthField('clientId', String(value))}
                placeholder={t('system.oauthClientId')}
              />
            ))}
            {accessField(t('system.oauthClientSecret'), (
              <Input
                type="password"
                value={String(oauthForm.clientSecret)}
                onChange={(value: any) => setOauthField('clientSecret', String(value))}
                placeholder={t('system.oauthClientSecret')}
              />
            ))}
            {accessField(t('system.oauthAuthEndpoint'), (
              <Input
                value={String(oauthForm.authorizationEndpoint)}
                onChange={(value: any) => setOauthField('authorizationEndpoint', String(value))}
                placeholder={t('system.oauthAuthEndpoint')}
              />
            ))}
            {accessField(t('system.oauthTokenEndpoint'), (
              <Input
                value={String(oauthForm.tokenEndpoint)}
                onChange={(value: any) => setOauthField('tokenEndpoint', String(value))}
                placeholder={t('system.oauthTokenEndpoint')}
              />
            ))}
            {accessField(t('system.oauthUserInfoEndpoint'), (
              <Input
                value={String(oauthForm.userInfoEndpoint)}
                onChange={(value: any) => setOauthField('userInfoEndpoint', String(value))}
                placeholder={t('system.oauthUserInfoEndpoint')}
              />
            ))}
            {accessField(t('system.oauthJwksUri'), (
              <Input
                value={String(oauthForm.jwksUri)}
                onChange={(value: any) => setOauthField('jwksUri', String(value))}
                placeholder={t('system.oauthJwksUri')}
              />
            ))}
            {accessField(t('system.oauthScopes'), (
              <Input
                value={String(oauthForm.scopes)}
                onChange={(value: any) => setOauthField('scopes', String(value))}
                placeholder={t('system.oauthScopes')}
              />
            ))}
            {accessField(t('system.oauthRedirectUri'), (
              <Input readonly value={redirectUri} />
            ))}
            {oauthForm.autoRegister && accessField(t('system.oauthDefaultRole'), (
              <Select
                value={oauthForm.defaultRole}
                options={[
                  { label: t('users.role1'), value: 1 },
                  { label: t('users.role2'), value: 2 },
                ]}
                onChange={(value: any) => setOauthField('defaultRole', Number(Array.isArray(value) ? value[0] : value) || 1)}
              />
            ))}
            {oauthForm.autoRegister && accessField(t('system.oauthDefaultTeam'), (
              <Select
                value={oauthForm.defaultTeamId}
                options={[
                  { label: t('system.oauthDefaultTeamNone'), value: 0 },
                  ...(teamList ?? []).map((team) => ({ label: team.name, value: team.id })),
                ]}
                onChange={(value: any) => setOauthField('defaultTeamId', Number(Array.isArray(value) ? value[0] : value) || 0)}
                placeholder={t('system.oauthDefaultTeamNone')}
              />
            ))}
          </div>
          <div className="settings-switch-row">
            <div>
              <strong>{t('system.oauthEnabled')}</strong>
            </div>
            <Switch value={oauthForm.enabled} onChange={(checked: any) => setOauthField('enabled', Boolean(checked))} />
          </div>
          <div className="settings-switch-row">
            <div>
              <strong>{t('system.oauthAutoRegister')}</strong>
              <span>{t('system.oauthAutoRegisterDesc')}</span>
            </div>
            <Switch value={oauthForm.autoRegister} onChange={(checked: any) => setOauthField('autoRegister', Boolean(checked))} />
          </div>
          <Space className="record-form__actions">
            <Button variant="outline" loading={discoverOidcMutation.isPending} onClick={() => discoverOidcMutation.mutate()}>
              {t('system.oidcAutoDiscover')}
            </Button>
            <Button theme="primary" loading={updateOauthMutation.isPending} onClick={() => updateOauthMutation.mutate()}>
              {t('system.oauthSave')}
            </Button>
          </Space>
        </div>
      </Card>

      <Card bordered={false} shadow={false} title={<Space align="center"><SettingIcon />{t('system.oauthLogtoConfig')}</Space>} subtitle={t('system.oauthLogtoConfigDesc')}>
        <div className="page-shell">
          <div className="access-form-grid">
            {accessField(t('system.oauthProvider'), (
              <Input readonly value={`Logto (${t('system.oauthProviderFixed')})`} />
            ))}
            {accessField(t('system.oauthLogtoDomain'), (
              <Input
                value={String(logtoForm.logtoDomain)}
                onChange={(value: any) => setLogtoField('logtoDomain', String(value))}
                placeholder={t('system.oauthLogtoDomain')}
              />
            ))}
            {accessField(t('system.oauthClientId'), (
              <Input
                value={String(logtoForm.clientId)}
                onChange={(value: any) => setLogtoField('clientId', String(value))}
                placeholder={t('system.oauthClientId')}
              />
            ))}
            {accessField(t('system.oauthClientSecret'), (
              <Input
                type="password"
                value={String(logtoForm.clientSecret)}
                onChange={(value: any) => setLogtoField('clientSecret', String(value))}
                placeholder={t('system.oauthClientSecret')}
              />
            ))}
            {accessField(t('system.oauthScopes'), (
              <Input
                value={String(logtoForm.scopes)}
                onChange={(value: any) => setLogtoField('scopes', String(value))}
                placeholder={t('system.oauthScopes')}
              />
            ))}
            {accessField(t('system.oauthRedirectUri'), (
              <Input readonly value={redirectUri} />
            ))}
          </div>
          <div className="settings-switch-row">
            <div>
              <strong>{t('system.oauthEnabled')}</strong>
            </div>
            <Switch value={logtoForm.enabled} onChange={(checked: any) => setLogtoField('enabled', Boolean(checked))} />
          </div>
          <Space className="record-form__actions">
            <Button theme="primary" loading={updateLogtoOauthMutation.isPending} onClick={() => updateLogtoOauthMutation.mutate()}>
              {t('system.oauthSave')}
            </Button>
          </Space>
        </div>
      </Card>
    </div>
  );
}
