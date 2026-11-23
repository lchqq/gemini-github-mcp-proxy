interface Env {
  GITHUB_PAT: string;
  ADMIN_PIN: string;
  SIGNING_SECRET: string;
  UPSTREAM_MCP_URL?: string;
  UPSTREAM_TOOLS?: string;
  ALLOWED_REDIRECT_PREFIX?: string;
  AUTHORIZE_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

type TokenPayload = {
  typ: "auth_code" | "access" | "refresh";
  sub?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  iat: number;
  exp: number;
  jti: string;
};

const DEFAULT_SCOPE = "repo read:org gist project issues pull_requests";
const DEFAULT_REDIRECT_PREFIX =
  "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-";
const DEFAULT_UPSTREAM_MCP_URL = "https://api.githubcopilot.com/mcp/";
const AUTH_CODE_TTL_SECONDS = 600;
const TOKEN_TTL_SECONDS = 315_360_000;
const AUTHORIZE_RATE_LIMIT_PERIOD_SECONDS = 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers":
    "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate",
};

const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "last-event-id",
  "mcp-protocol-version",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GitHub MCP returns text files as a status TextContent block plus an
 * EmbeddedResource block. Gemini currently drops the resource block, leaving
 * only "successfully downloaded text file". Flatten textual resources into
 * ordinary TextContent so the model receives the file body.
 */
export function normalizeGitHubMcpContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeGitHubMcpContent);
  }
  if (!isRecord(value)) return value;

  if (
    value.type === "resource" &&
    isRecord(value.resource) &&
    typeof value.resource.text === "string"
  ) {
    return { type: "text", text: value.resource.text };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      normalizeGitHubMcpContent(child),
    ]),
  );
}

export function normalizeGitHubMcpJson(text: string): string {
  try {
    return JSON.stringify(normalizeGitHubMcpContent(JSON.parse(text)));
  } catch {
    return text;
  }
}

export function normalizeGitHubMcpSseLine(line: string): string {
  const hasNewline = line.endsWith("\n");
  const hasCarriageReturn = line.endsWith("\r\n");
  const body = line.replace(/\r?\n$/, "");
  if (!body.startsWith("data:")) return line;

  const data = body.slice(5).trimStart();
  if (!data || data === "[DONE]") return line;

  try {
    const normalized = normalizeGitHubMcpJson(data);
    const ending = hasNewline ? (hasCarriageReturn ? "\r\n" : "\n") : "";
    return `data: ${normalized}${ending}`;
  } catch {
    return line;
  }
}

function normalizeSseStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline + 1);
          buffer = buffer.slice(newline + 1);
          controller.enqueue(encoder.encode(normalizeGitHubMcpSseLine(line)));
          newline = buffer.indexOf("\n");
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) {
          controller.enqueue(encoder.encode(normalizeGitHubMcpSseLine(buffer)));
        }
      },
    }),
  );
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function base64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createSignedToken(
  env: Env,
  claims: Omit<TokenPayload, "iat" | "exp" | "jti">,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
  };
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env.SIGNING_SECRET),
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

async function verifySignedToken(
  env: Env,
  token: string,
  expectedType?: TokenPayload["typ"],
): Promise<TokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [header, body, signature] = parts;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(env.SIGNING_SECRET),
    Uint8Array.from(base64urlDecode(signature)).buffer,
    encoder.encode(`${header}.${body}`),
  );
  if (!valid) throw new Error("Invalid token signature");

  const parsedHeader = JSON.parse(decoder.decode(base64urlDecode(header))) as {
    alg?: string;
  };
  if (parsedHeader.alg !== "HS256") throw new Error("Unsupported token algorithm");

  const payload = JSON.parse(
    decoder.decode(base64urlDecode(body)),
  ) as TokenPayload;
  if (!payload.typ || !payload.exp || payload.exp <= Date.now() / 1000) {
    throw new Error("Expired token");
  }
  if (expectedType && payload.typ !== expectedType) {
    throw new Error("Unexpected token type");
  }
  return payload;
}

async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(value),
  )));
}

async function safelyEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char] ?? char,
  );
}

const AUTHORIZATION_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function isAllowedRedirect(env: Env, redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    const prefix = env.ALLOWED_REDIRECT_PREFIX || DEFAULT_REDIRECT_PREFIX;
    if (url.protocol !== "https:" || prefix === "") return false;
    const allowed = new URL(prefix);
    return (
      url.origin === allowed.origin &&
      url.pathname.startsWith(allowed.pathname)
    );
  } catch {
    return false;
  }
}

function hasValidPkce(params: URLSearchParams): boolean {
  const challenge = params.get("code_challenge") ?? "";
  const method = params.get("code_challenge_method") ?? "";
  return method === "S256" && /^[A-Za-z0-9_-]{43,128}$/.test(challenge);
}

async function enforceAuthorizeRateLimit(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (!env.AUTHORIZE_RATE_LIMITER) return null;

  const clientIp =
    request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  try {
    const outcome = await env.AUTHORIZE_RATE_LIMITER.limit({
      key: `${clientIp}:authorize`,
    });
    if (outcome.success) return null;
  } catch (error) {
    console.error("Authorize rate limiter failed", error);
    return new Response("Authorization temporarily unavailable", {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  return new Response("Too many authorization attempts. Try again later.", {
    status: 429,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(AUTHORIZE_RATE_LIMIT_PERIOD_SECONDS),
      "x-content-type-options": "nosniff",
    },
  });
}

function authorizationPage(params: URLSearchParams, error = ""): string {
  const values = {
    client_id: params.get("client_id") ?? "",
    redirect_uri: params.get("redirect_uri") ?? "",
    state: params.get("state") ?? "",
    code_challenge: params.get("code_challenge") ?? "",
    code_challenge_method: params.get("code_challenge_method") ?? "S256",
    scope: params.get("scope") || DEFAULT_SCOPE,
  };
  const errorBlock = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>授权 Gemini GitHub MCP</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0d1117; color: #e6edf3; }
    main { width: min(420px, 100%); padding: 30px; border: 1px solid #30363d;
      border-radius: 16px; background: #161b22; box-shadow: 0 18px 50px #0008; }
    h1 { margin: 0 0 10px; font-size: 1.3rem; }
    p { margin: 0 0 20px; color: #9da7b3; line-height: 1.5; }
    label { display: block; margin-bottom: 7px; font-size: .9rem; font-weight: 650; }
    input { width: 100%; padding: 13px; margin-bottom: 18px; border: 1px solid #3d444d;
      border-radius: 9px; background: #0d1117; color: inherit; font-size: 1rem; }
    button { width: 100%; padding: 13px; border: 0; border-radius: 9px;
      background: #238636; color: white; font-size: 1rem; font-weight: 700; cursor: pointer; }
    button:hover { background: #2ea043; }
    .error { margin-bottom: 16px; padding: 11px 12px; border: 1px solid #f85149;
      border-radius: 8px; background: #f851491a; color: #ff7b72; }
  </style>
</head>
<body>
  <main>
    <h1>授权 Gemini GitHub MCP</h1>
    <p>输入部署时生成的 12 位授权 PIN。授权后，Gemini 可调用 GitHub Remote MCP 的代码、Issue 与 PR 工具。</p>
    ${errorBlock}
    <form method="post" action="/authorize">
      ${Object.entries(values)
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`,
        )
        .join("\n      ")}
      <label for="pin">授权 PIN</label>
      <input id="pin" name="pin" type="password" inputmode="numeric"
        autocomplete="current-password" required autofocus>
      <button type="submit">授权并继续</button>
    </form>
  </main>
</body>
</html>`;
}

function metadataResponse(request: Request): Response {
  const baseUrl = new URL(request.url).origin;
  return json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  });
}

function protectedResourceResponse(request: Request): Response {
  const baseUrl = new URL(request.url).origin;
  return json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
  });
}

async function parseBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const data = await request.json<Record<string, unknown>>().catch(() => ({}));
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, String(value ?? "")]),
    );
  }
  const form = await request.formData().catch(() => new FormData());
  const result: Record<string, string> = {};
  form.forEach((value, key) => {
    result[key] = String(value);
  });
  return result;
}

async function registerClient(request: Request, env: Env): Promise<Response> {
  const body = await request
    .json<Record<string, unknown>>()
    .catch(() => ({} as Record<string, unknown>));
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  const validRedirectUris = redirectUris.every(
    (value) => typeof value === "string" && isAllowedRedirect(env, value),
  );
  if (redirectUris.length === 0 || !validRedirectUris) {
    return json(
      {
        error: "invalid_client_metadata",
        error_description: "redirect_uris must contain allowed Gemini callbacks",
      },
      { status: 400 },
    );
  }
  return json(
    {
      client_id: `mcp-client-${crypto.randomUUID()}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(typeof body.client_name === "string"
        ? { client_name: body.client_name }
        : {}),
    },
    { status: 201 },
  );
}

async function authorizeRequest(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (request.method === "GET") {
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!isAllowedRedirect(env, redirectUri)) {
      return new Response("Unsupported redirect_uri", { status: 400 });
    }
    if (!hasValidPkce(params)) {
      return new Response("PKCE S256 code_challenge is required", {
        status: 400,
      });
    }
    return new Response(authorizationPage(params), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...AUTHORIZATION_HEADERS,
      },
    });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, POST" },
    });
  }

  const rateLimited = await enforceAuthorizeRateLimit(request, env);
  if (rateLimited) return rateLimited;

  const formData = await request.formData();
  for (const [key, value] of formData.entries()) {
    params.set(key, String(value));
  }
  const pin = params.get("pin") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!isAllowedRedirect(env, redirectUri)) {
    return new Response("Unsupported redirect_uri", { status: 400 });
  }
  if (!hasValidPkce(params)) {
    return new Response("PKCE S256 code_challenge is required", {
      status: 400,
    });
  }
  if (!(await safelyEqual(pin, env.ADMIN_PIN))) {
    return new Response(authorizationPage(params, "授权 PIN 不正确。"), {
      status: 401,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...AUTHORIZATION_HEADERS,
      },
    });
  }

  params.delete("pin");
  const code = await createSignedToken(
    env,
    {
      typ: "auth_code",
      client_id: params.get("client_id") ?? "gemini",
      redirect_uri: redirectUri,
      code_challenge: params.get("code_challenge")!,
      code_challenge_method: "S256",
      scope: params.get("scope") || DEFAULT_SCOPE,
    },
    AUTH_CODE_TTL_SECONDS,
  );
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  const state = params.get("state");
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}

async function tokenRequest(request: Request, env: Env): Promise<Response> {
  const body = await parseBody(request);
  const noStore = {
    "cache-control": "no-store",
    pragma: "no-cache",
  };
  let clientId = body.client_id || "gemini";
  let scope = body.scope || DEFAULT_SCOPE;

  if (body.grant_type === "authorization_code") {
    if (!body.code) {
      return json(
        { error: "invalid_request", error_description: "Missing code" },
        { status: 400, headers: noStore },
      );
    }
    try {
      const claims = await verifySignedToken(env, body.code, "auth_code");
      if (
        body.client_id &&
        claims.client_id &&
        body.client_id !== claims.client_id
      ) {
        throw new Error("Authorization code was issued to another client");
      }
      clientId = claims.client_id || clientId;
      scope = claims.scope || scope;
      const verifier = body.code_verifier || "";
      if (
        !claims.code_challenge ||
        claims.code_challenge_method !== "S256" ||
        !verifier ||
        !(await safelyEqual(await sha256(verifier), claims.code_challenge))
      ) {
        return json(
          {
            error: "invalid_grant",
            error_description: "PKCE verification failed",
          },
          { status: 400, headers: noStore },
        );
      }
    } catch (error) {
      return json(
        {
          error: "invalid_grant",
          error_description:
            error instanceof Error ? error.message : "Invalid authorization code",
        },
        { status: 400, headers: noStore },
      );
    }
  } else if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) {
      return json(
        {
          error: "invalid_request",
          error_description: "Missing refresh_token",
        },
        { status: 400, headers: noStore },
      );
    }
    try {
      const claims = await verifySignedToken(env, body.refresh_token, "refresh");
      if (
        body.client_id &&
        claims.client_id &&
        body.client_id !== claims.client_id
      ) {
        throw new Error("Refresh token was issued to another client");
      }
      clientId = claims.client_id || clientId;
      scope = claims.scope || scope;
    } catch (error) {
      return json(
        {
          error: "invalid_grant",
          error_description:
            error instanceof Error ? error.message : "Invalid refresh token",
        },
        { status: 400, headers: noStore },
      );
    }
  } else {
    return json(
      {
        error: "unsupported_grant_type",
        error_description: "Unsupported grant_type",
      },
      { status: 400, headers: noStore },
    );
  }

  const accessToken = await createSignedToken(
    env,
    { typ: "access", sub: clientId, client_id: clientId, scope },
    TOKEN_TTL_SECONDS,
  );
  const refreshToken = await createSignedToken(
    env,
    { typ: "refresh", sub: clientId, client_id: clientId, scope },
    TOKEN_TTL_SECONDS,
  );
  return json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    },
    { headers: noStore },
  );
}

function unauthorizedMcp(request: Request, detail: string): Response {
  const baseUrl = new URL(request.url).origin;
  return json(
    { error: "unauthorized", error_description: detail },
    {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

async function proxyMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return unauthorizedMcp(request, "Missing Bearer token");
  }
  try {
    await verifySignedToken(env, authorization.slice(7).trim(), "access");
  } catch (error) {
    return unauthorizedMcp(
      request,
      error instanceof Error ? error.message : "Invalid Bearer token",
    );
  }
  if (!env.GITHUB_PAT) {
    return json(
      { error: "server_error", error_description: "GITHUB_PAT is not configured" },
      { status: 503, headers: CORS_HEADERS },
    );
  }

  const upstreamUrl = env.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM_MCP_URL;
  const upstreamHeaders = new Headers({ authorization: `Bearer ${env.GITHUB_PAT}` });
  const configuredTools = env.UPSTREAM_TOOLS?.trim();
  if (configuredTools) upstreamHeaders.set("x-mcp-tools", configuredTools);
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  if (!upstreamHeaders.has("accept")) {
    upstreamHeaders.set("accept", "application/json, text/event-stream");
  }

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
    redirect: "manual",
  });
  const headers = new Headers(CORS_HEADERS);
  for (const name of [
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
    "cache-control",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  let body: BodyInit | null = upstream.body;
  if (upstream.body && contentType.includes("application/json")) {
    body = normalizeGitHubMcpJson(await upstream.text());
  } else if (upstream.body && contentType.includes("text/event-stream")) {
    body = normalizeSseStream(upstream.body);
  }

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({
          status:
            env.GITHUB_PAT && env.ADMIN_PIN && env.SIGNING_SECRET ? "ok" : "error",
          service: "gemini-github-mcp-proxy",
        });
      }
      if (
        url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp"
      ) {
        return withCors(protectedResourceResponse(request));
      }
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
        url.pathname === "/.well-known/openid-configuration"
      ) {
        return withCors(metadataResponse(request));
      }
      if (url.pathname === "/register" && request.method === "POST") {
        return withCors(await registerClient(request, env));
      }
      if (url.pathname === "/authorize") {
        return authorizeRequest(request, env);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        return withCors(await tokenRequest(request, env));
      }
      if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
        return withCors(await proxyMcp(request, env));
      }
      return json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return json(
        {
          error: "server_error",
          error_description:
            error instanceof Error ? error.message : "Unexpected error",
        },
        { status: 500 },
      );
    }
  },
};
