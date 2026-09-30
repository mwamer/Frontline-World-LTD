/**
 * Reviewer authentication for the review dashboard.
 *
 * A reviewer signs in with GitHub, the same account they already use for the
 * CMS, and gets a signed session cookie. The design keeps the two existing
 * Workers' concerns apart:
 *
 *   oauth-proxy      The Decap protocol needs a GitHub *token* in the browser,
 *                    because Decap commits with it. A dashboard never needs
 *                    that, so it does not use that Worker and never holds a
 *                    token in the page.
 *   this module      Exchanges the one-time code for a token, checks the login
 *                    against ALLOWED_USERS, then throws the token away. What
 *                    survives is a signed cookie carrying the username and an
 *                    expiry.
 *
 * The cookie is signed with HMAC-SHA256 over its own payload with
 * SESSION_SECRET, and that secret is never in the repository, in a variable, or
 * in a response. A reviewer cannot mint a session, and there is no way to edit
 * one to claim to be someone else.
 *
 * The GitHub account is the identity. It is not re-checked against GitHub on
 * every request — that would put the dashboard at GitHub's rate limit and make
 * it depend on GitHub being up — so a session lasts a bounded time and revoking
 * access means removing the username from ALLOWED_USERS, which takes effect at
 * the next sign-in.
 */

import { escape } from "./html.js";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";

// Resolved through the same base the Contents API uses, so a test can point the
// `/user` call at the stub and read the headers it was actually sent. Nothing sets
// `GITHUB_API_BASE` in production, so this is `https://api.github.com/user` there.
function userUrl(env) {
  return `${String(env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "")}/user`;
}

export const SESSION_COOKIE = "fw_review_session";
const STATE_COOKIE = "fw_review_state";

/** A session lasts a working day. */
const SESSION_TTL_SECONDS = 60 * 60 * 12;

/** The sign-in handshake is short-lived: it only has to survive one redirect. */
const STATE_TTL_SECONDS = 600;

const encoder = new TextEncoder();

/**
 * Check who is asking. Returns `{ login }` for a valid session, or `null` for
 * no session, an expired one, a tampered one, or a session whose account is no
 * longer on the allowed list.
 */
export async function identify(request, env) {
  if (!env.SESSION_SECRET) return null;

  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;

  const parts = raw.split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  const expected = await sign(payload, env.SESSION_SECRET);
  if (!timingSafeEqual(signature, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(decodeBase64Url(payload));
  } catch {
    return null;
  }

  if (!claims || typeof claims.login !== "string" || !claims.login) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;

  // The allowlist is re-read on every request rather than only at sign-in, so
  // removing a username from ALLOWED_USERS takes effect on the session that
  // username is holding, not on the next sign-in.
  if (!isAllowedUser(claims.login, env)) return null;

  return { login: claims.login };
}

/** Begin sign-in: a state cookie, then a redirect to GitHub. */
export function startSignIn(request, env) {
  const missing = missingConfig(env);
  if (missing) return problem(missing);

  const state = crypto.randomUUID();
  const target = new URL(GITHUB_AUTHORIZE);
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  // The narrowest scope that identifies an account. This Worker writes nothing
  // to GitHub, so it does not need repo access at all — which is the point:
  // a leak of this token would not be a leak of the repository.
  target.searchParams.set("scope", "read:user");
  target.searchParams.set("redirect_uri", `${new URL(request.url).origin}/callback`);
  // The cookie below is what proves on the way back that this browser started
  // the exchange, so a callback cannot be replayed into someone else's session.
  target.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "set-cookie": `${STATE_COOKIE}=${state}; Path=/; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      "cache-control": "no-store",
    },
  });
}

/** Finish sign-in: code for token, check the login, then sign a cookie. */
export async function finishSignIn(request, env) {
  const missing = missingConfig(env);
  if (missing) return problem(missing);

  const url = new URL(request.url);

  const githubError = url.searchParams.get("error");
  if (githubError) {
    return problem(`GitHub returned an error: ${url.searchParams.get("error_description") || githubError}`);
  }

  const code = url.searchParams.get("code");
  if (!code) return problem("GitHub did not return an authorization code.");

  const state = url.searchParams.get("state");
  const expected = readCookie(request, STATE_COOKIE);
  if (!state || !expected || state !== expected) {
    return problem("The sign-in could not be verified. Please try again.");
  }

  const tokenResponse = await fetch(GITHUB_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/callback`,
    }),
  });

  if (!tokenResponse.ok) {
    return problem(`GitHub rejected the token request (HTTP ${tokenResponse.status}).`);
  }

  const payload = await tokenResponse.json();
  if (!payload.access_token) {
    return problem(payload.error_description || "GitHub did not return an access token.");
  }

  // The login is the only thing wanted from the token, and it is fetched with
  // `read:user`, which cannot reach the repository. The token is not stored, not
  // logged, and not put in the redirect: it goes out of scope here.
  const userResponse = await fetch(userUrl(env), {
    headers: {
      authorization: `Bearer ${payload.access_token}`,
      accept: "application/vnd.github+json",
      // The API answers 403 to a request with no User-Agent, which would read as
      // "could not read the account name" rather than as the header problem it is.
      "user-agent": "frontline-review-dashboard",
    },
  });
  if (!userResponse.ok) {
    return problem("Signed in to GitHub, but the account name could not be read.");
  }

  const login = String((await userResponse.json()).login || "");
  if (!login) return problem("GitHub did not return an account name.");
  if (!isAllowedUser(login, env)) {
    // Said plainly, because the fix is for the repository owner, not the person
    // who tried.
    return problem(
      `${login} is not on this dashboard's reviewer list. Ask the repository owner to add you, then sign in again.`
    );
  }

  const session = await createSession(login, env.SESSION_SECRET);

  // Two cookies, appended one at a time. Joined into a single `set-cookie` they
  // read as one malformed cookie to a browser, which then keeps no session at
  // all — the sign-in reports success and the dashboard says nobody is signed in.
  const headers = new Headers({ location: "/", "cache-control": "no-store" });
  headers.append("set-cookie", `${SESSION_COOKIE}=${session}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
  headers.append("set-cookie", `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);

  return new Response(null, { status: 302, headers });
}

export function signOut() {
  return new Response(null, {
    status: 302,
    headers: {
      location: "/login",
      "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      "cache-control": "no-store",
    },
  });
}

/**
 * Mint a session for a named account. Test-only, and reachable only while
 * ALLOW_TEST_RESET is set, which lives in the git-ignored .dev.vars and never
 * in wrangler.toml, so a deployed Worker has no such route.
 *
 * It is not a way around authentication: the cookie it returns has to satisfy
 * the same `identify()` as one from a real GitHub sign-in, with the same
 * signature and the same allowlist check. Minting one for an account that is
 * not on ALLOWED_USERS is refused, so a test cannot accidentally pass because
 * authorisation was skipped.
 */
export async function testSession(login, env) {
  if (env.ALLOW_TEST_RESET !== "true") return null;
  if (!env.SESSION_SECRET) return null;
  if (!isAllowedUser(login, env)) return null;
  return createSession(login, env.SESSION_SECRET);
}

/** An expired session, for proving a stale cookie is refused. */
export async function testExpiredSession(login, env) {
  if (env.ALLOW_TEST_RESET !== "true") return null;
  if (!env.SESSION_SECRET) return null;
  if (!isAllowedUser(login, env)) return null;

  const claims = { login, iat: 1, exp: 2 }; // 1970: long past.
  const payload = encodeBase64Url(JSON.stringify(claims));
  return `${payload}.${await sign(payload, env.SESSION_SECRET)}`;
}

// ---- Sessions -------------------------------------------------------------

async function createSession(login, secret) {
  const claims = {
    login,
    // Issued-at, kept only so a session can be recognised as older in a log.
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payload = encodeBase64Url(JSON.stringify(claims));
  return `${payload}.${await sign(payload, secret)}`;
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return encodeBase64Url(new Uint8Array(signature));
}

// A length difference is a mismatch too, so the two lengths are compared before
// the loop. Without it a wrong-length signature returns early and leaks its
// length through timing.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function isAllowedUser(login, env) {
  const allowed = String(env.ALLOWED_USERS || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(String(login).toLowerCase());
}

function missingConfig(env) {
  if (!env.GITHUB_CLIENT_ID) return "GITHUB_CLIENT_ID is not set on this Worker.";
  if (!env.GITHUB_CLIENT_SECRET) return "GITHUB_CLIENT_SECRET is not set on this Worker.";
  if (!env.SESSION_SECRET) return "SESSION_SECRET is not set on this Worker.";
  if (!env.ALLOWED_USERS) return "ALLOWED_USERS is not set on this Worker, so no one can sign in.";
  return null;
}

function problem(message) {
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Sign-in problem</title></head>
<body>
  <h1>Sign-in problem</h1>
  <p>${escape(message)}</p>
  <p><a href="/login">Try again</a></p>
</body>
</html>`;

  return new Response(body, {
    status: 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, private",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

// ---- CSRF -------------------------------------------------------------------

/**
 * A token for the POST forms, derived from the session secret.
 *
 * The session cookie is `SameSite=Strict`, which already stops a cross-site
 * form post from carrying it. This is the belt to that pair of braces, added
 * because these forms now change a public repository: a mistake in a cookie
 * attribute should not be the only thing standing between a reviewer's browser
 * and a commit.
 *
 * The token is an HMAC over the account name, so it is stable for a reviewer for
 * as long as the secret is, which is what lets a page render a form and a POST
 * verify it without storing anything. A different account gets a different
 * token, and there is no route that reveals one to anybody but the reviewer it
 * belongs to: computing it needs `SESSION_SECRET`, and the value only ever
 * reaches the page that the reviewer's own session already unlocks.
 */
export async function csrfToken(env, login) {
  if (!env.SESSION_SECRET || !login) return "";
  return sign(`csrf:${login}`, env.SESSION_SECRET);
}

/**
 * Check a submitted token against the one for this account.
 *
 * Compared with the same constant-time comparison used for the session
 * signature, so a wrong token is not distinguishable from a right one by how
 * long the answer took.
 */
export async function verifyCsrf(env, login, submitted) {
  if (!login || !submitted) return false;
  const expected = await csrfToken(env, login);
  if (!expected) return false;
  return timingSafeEqual(String(submitted), expected);
}

// ---- Cookies --------------------------------------------------------------

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function encodeBase64Url(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
