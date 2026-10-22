import { expect, type Page, type BrowserContext } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const origin = 'http://127.0.0.1:4180';
const clients = new WeakMap<BrowserContext, Client>();

export async function readyCanvas(page: Page, navigate = true) {
  if (navigate) await page.goto('/');
  await expect(page.getByLabel('Diagram name', { exact: true })).toBeEnabled();
  if (await page.evaluate(() => localStorage.getItem('diagrams-agent-paused') === 'true')) {
    await page.getByRole('button', { name: 'Connect this canvas', exact: true }).click();
  }
  await expect(page.getByTestId('connection-status')).toHaveText('Connected');
}

export async function authorizeAgent(page: Page, name = 'Browser test agent', allow = true) {
  let information: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = '';
  let authorization: URL | undefined;
  const state = randomBytes(24).toString('hex');
  const callback = 'http://127.0.0.1:32199/callback';
  const provider: OAuthClientProvider = {
    redirectUrl: callback,
    clientMetadata: { client_name: name, redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    state: () => state,
    clientInformation: () => information,
    saveClientInformation: value => { information = value; },
    tokens: () => tokens,
    saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => verifier,
    redirectToAuthorization: value => { authorization = value; },
    invalidateCredentials: scope => {
      if (scope === 'all' || scope === 'tokens') tokens = undefined;
      if (scope === 'all' || scope === 'client') information = undefined;
      if (scope === 'all' || scope === 'verifier') verifier = '';
    },
  };
  const client = new Client({ name, version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { authProvider: provider });
  try { await client.connect(transport); } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }
  if (!authorization) throw new Error('The SDK did not start OAuth.');
  const consent = await page.context().newPage();
  try {
    await consent.route(callback + '**', route => route.fulfill({ contentType: 'text/html', body: '<p>Authorization complete.</p>' }));
    await consent.goto(authorization.toString());
    await expect(consent.getByRole('heading', { name: 'Connect this agent?' })).toBeVisible();
    const [approval] = await Promise.all([
      consent.waitForResponse(response => response.url() === origin + '/oauth/approve'),
      consent.getByRole('button', { name: allow ? 'Allow access' : 'Cancel', exact: true }).click(),
    ]);
    expect(approval.status(), 'OAuth consent should redirect to the agent').toBe(303);
    expect(approval.request().headers().origin).toBe(origin);
    await consent.waitForURL(callback + '**', { timeout: 8_000 });
    const result = new URL(consent.url());
    expect(result.searchParams.get('state')).toBe(state);
    expect(result.searchParams.get('iss')).toBe(origin);
    if (!allow) {
      expect(result.searchParams.get('error')).toBe('access_denied');
      await client.close();
      throw new Error('Authorization declined');
    }
    const code = result.searchParams.get('code');
    if (!code) throw new Error('No authorization code was returned.');
    await transport.finishAuth(code);
    await client.close();
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { authProvider: provider }));
  } finally { await consent.close(); }
  page.context().on('close', () => { void client.close(); });
  return client;
}

export async function connectAgent(page: Page, navigate = true) {
  await readyCanvas(page, navigate);
  let client = clients.get(page.context());
  if (!client) {
    client = await authorizeAgent(page);
    clients.set(page.context(), client);
  }
  return client;
}

