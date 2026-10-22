import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

// Credentials belong to this local CLI, never to the diagram server or source
// control. A lock prevents parallel refreshes from replaying a rotated token.
export async function connectMCP() {
  const endpoint = new URL(process.env.DIAGRAMS_MCP_URL ?? (process.env.DIAGRAMS_PUBLIC_URL ?? 'http://localhost:5173') + '/mcp');
  const origin = endpoint.origin;
  mkdirSync('.cache', { recursive: true, mode: 0o700 });
  const path = '.cache/mcp-auth.json';
  const lockPath = path + '.lock';
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch { throw new Error('Another diagram CLI is using its connection. If it stopped unexpectedly, remove .cache/mcp-auth.json.lock.'); }
  let listener;
  let timer;
  let client;
  function cleanup() {
    clearTimeout(timer);
    listener?.close();
    if (lock !== undefined) { closeSync(lock); lock = undefined; unlinkSync(lockPath); }
  }
  try {
    let saved = {};
    try { saved = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the CLI connection. Remove .cache/mcp-auth.json to pair again.'); }
    if (saved.endpoint !== endpoint.href) saved = { endpoint: endpoint.href };
    const persist = () => {
      writeFileSync(path + '.tmp', JSON.stringify(saved), { mode: 0o600 });
      renameSync(path + '.tmp', path);
    };
    const state = randomBytes(32).toString('base64url');
    let verifier;
    let complete;
    let fail;
    const callback = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    // Suppress a premature unhandled rejection while the SDK starts discovery.
    void callback.catch(() => {});
    listener = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state || url.searchParams.get('iss') !== origin) {
        response.writeHead(400); response.end('Invalid authorization response.'); return;
      }
      if (url.searchParams.has('error')) {
        response.end('Connection canceled. You can close this tab.');
        fail(new Error('Authorization was declined.')); return;
      }
      const code = url.searchParams.get('code');
      if (!code) { response.writeHead(400); response.end('Missing authorization code.'); return; }
      response.end('Approval received. Return to your terminal and keep your diagram app open.');
      complete(code);
    });
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const redirectUrl = 'http://127.0.0.1:' + listener.address().port + '/callback';
    const provider = {
      redirectUrl,
      clientMetadata: {
        client_name: 'Diagrams CLI', redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      },
      state: () => state,
      clientInformation: () => saved.client,
      saveClientInformation: information => { saved.client = information; persist(); },
      tokens: () => saved.tokens,
      saveTokens: tokens => { saved.tokens = tokens; persist(); },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => verifier,
      redirectToAuthorization: url => {
        console.error('Approve the connection in the browser that contains your diagrams:\n' + url.href);
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? null : 'xdg-open';
        if (command) {
          const child = spawn(command, [url.href], { stdio: 'ignore' });
          child.on('error', () => {}); child.unref();
        }
        timer = setTimeout(() => fail(new Error('Approval timed out. Run the command again.')), 5 * 60_000);
      },
      invalidateCredentials: scope => {
        if (scope === 'all' || scope === 'client') delete saved.client;
        if (scope === 'all' || scope === 'tokens') delete saved.tokens;
        if (scope === 'all' || scope === 'verifier') verifier = undefined;
        persist();
      },
    };
    client = new Client({ name: 'diagrams-cli', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
    try { await client.connect(transport); }
    catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      await transport.finishAuth(await callback);
      await client.close();
      await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
    }
    clearTimeout(timer); listener.close();
    return { client, close: async () => { try { await client.close(); } finally { cleanup(); } } };
  } catch (error) {
    try { await client?.close(); } finally { cleanup(); }
    throw error;
  }
}

