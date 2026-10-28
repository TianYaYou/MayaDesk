export interface UserSession {
  id: string;
  email: string;
  displayName: string;
  provider: 'email' | 'google';
  accessToken: string;
}

export async function loginWithEmailPassword(
  apiBaseUrl: string,
  email: string,
  password: string
): Promise<UserSession> {
  const res = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error('邮箱或密码验证失败');
  }
  const data = await res.json();
  return {
    id: 'usr-admin-01',
    email,
    displayName: email.split('@')[0],
    provider: 'email',
    accessToken: data.access_token,
  };
}

export async function fetchGoogleOAuthUrl(apiBaseUrl: string): Promise<string> {
  const res = await fetch(`${apiBaseUrl}/auth/google/url`);
  const data = await res.json();
  return data.authorize_url;
}
