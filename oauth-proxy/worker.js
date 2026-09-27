/**
 * Decap CMS GitHub OAuth proxy for Frontline World.
 *
 * A static site cannot hold a GitHub OAuth client secret, so Decap opens this
 * Worker in a popup instead. The Worker holds the secret, swaps GitHub's
 * one-time code for an access token, and hands that token to the admin page.
 *
 * Decap drives this popup with the Netlify Identity protocol rather than a
 * plain redirect, and the order matters:
 *
 *   1. /auth returns a page that posts the literal string "authorizing:github"
 *      to the opener. Decap only registers its result listener after it sees
 *      that handshake, so redirecting straight to GitHub leaves the login
 *      hanging with no error.
 *   2. That page then navigates to GitHub's consent screen.
 *   3. GitHub returns to /callback, where the code becomes a token.
 *   4. /callback posts the literal string
 *      "authorization:github:success:{"token":...,"provider":"github"}" to the
 *      opener. Decap parses the text after the prefix as JSON, so the payload
 *      has to be a string. Posting an object throws, because Decap calls
 *      .indexOf() on it.
 *
 * A popup can only postMessage to an exact origin, so CMS_ORIGIN must be the
 * origin of the page that opens the popup. Post to the Worker's own origin
 * instead and the browser discards the message without a word.
 *
 * Deploy with:  npx wrangler deploy
 * Variable:     CMS_ORIGIN, set in wrangler.toml
 * Secrets:      npx wrangler secret put GITHUB_CLIENT_ID
 *               npx wrangler secret put GITHUB_CLIENT_SECRET
 * Optional:     npx wrangler secret put ALLOWED_USERS   (comma-separated GitHub usernames)
 *
 * The GitHub OAuth App's Authorization callback URL must be exactly
 * <worker-host>/callback, where <worker-host> is this Worker's hostname.
 */

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";

// Decap asks for the `repo` scope by default, which would grant the minted
// token control of every public *and private* repository on the account. This
// site only needs its own public repository, so the narrow scopes are requested
// instead and config.yml sets auth_scope to match. Widening this to "repo user"
// is the documented fallback if Decap ever rejects the login for insufficient
// scope; it also widens access to every private repository on the account.
const SCOPES = "public_repo user";

const STATE_COOKIE = "fw_oauth_state";
const HANDSHAKE = "authorizing:github";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") return handshake(request, url, env);
    if (url.pathname === "/callback") return exchange(request, url, env);

    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

// Step 1: greet the popup with the handshake Decap is waiting for, then send
// the editor on to GitHub. This cannot be a 302, because a redirect would tear
// the page down before it could run the handshake.
function handshake(request, url, env) {
  const missing = missingConfig(env);
  if (missing) return problem(missing, env);

  const state = crypto.randomUUID();
  const target = new URL(GITHUB_AUTHORIZE);
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("scope", SCOPES);
  target.searchParams.set("redirect_uri", `${url.origin}/callback`);
  // Decap does not generate an OAuth state, so the proxy does, and the cookie
  // below is what proves on the way back that this popup started the exchange.
  target.searchParams.set("state", state);

  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signing in</title></head>
<body>
<p>Connecting to GitHub. This window closes by itself.</p>
<script>
  (function () {
    var TARGET = ${json(env.CMS_ORIGIN)};
    var NEXT = ${json(target.toString())};
    var HANDSHAKE = ${json(HANDSHAKE)};

    if (!window.opener) {
      document.body.textContent =
        "This sign-in window lost the page that opened it. Go back to /admin/ and choose Login with GitHub again.";
      return;
    }

    var leaving = false;
    function goToGitHub() {
      if (leaving) return;
      leaving = true;
      window.location.replace(NEXT);
    }

    // Only trust the reply from this Worker's own origin.
    window.addEventListener("message", function (event) {
      if (event.origin !== window.location.origin) return;
      if (event.data === HANDSHAKE) goToGitHub();
    });

    window.opener.postMessage(HANDSHAKE, TARGET);
    // Decap normally answers the handshake. Carry on regardless, so a dropped
    // reply cannot strand the editor on a blank page.
    setTimeout(goToGitHub, 800);
  })();
</script>
</body>
</html>`;

  return html(body, {
    "set-cookie": `${STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
  });
}

// Step 2: swap the one-time code for an access token, then hand it to the admin
// window. Never log the code or the token.
async function exchange(request, url, env) {
  const missing = missingConfig(env);
  if (missing) return problem(missing, env);

  const githubError = url.searchParams.get("error");
  if (githubError) {
    return problem(
      `GitHub returned an error: ${url.searchParams.get("error_description") || githubError}`,
      env
    );
  }

  const code = url.searchParams.get("code");
  if (!code) return problem("GitHub did not return an authorization code.", env);

  const state = url.searchParams.get("state");
  const expected = readCookie(request, STATE_COOKIE);
  if (!state || !expected || state !== expected) {
    return problem("The sign-in could not be verified. Please try again.", env);
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
    return problem(`GitHub rejected the token request (HTTP ${tokenResponse.status}).`, env);
  }

  const payload = await tokenResponse.json();
  if (!payload.access_token) {
    return problem(payload.error_description || "GitHub did not return an access token.", env);
  }

  if (env.ALLOWED_USERS) {
    const blocked = await rejectUnknownUser(payload.access_token, env.ALLOWED_USERS);
    if (blocked) return problem(blocked, env);
  }

  return success(payload.access_token, env, {
    "set-cookie": `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  });
}

async function rejectUnknownUser(token, allowedUsers) {
  const allowed = allowedUsers
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  const userResponse = await fetch(GITHUB_USER, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });

  if (!userResponse.ok) {
    return "Signed in to GitHub, but the account name could not be read to check the editor list.";
  }

  const login = ((await userResponse.json()).login || "").toLowerCase();
  if (!allowed.includes(login)) {
    return `${login} is not on this CMS's editor list. Ask the repository owner to add you, then sign in again.`;
  }
  return null;
}

// Hand the token to Decap. It expects a string with a known prefix, and reads
// everything after the prefix as JSON, so the payload is built in the page
// rather than pre-serialised here.
function success(token, env, extraHeaders) {
  const body = page(
    "Signing in",
    `<p>Signed in. This window closes by itself.</p>`,
    `var token = ${json(token)};
     window.opener.postMessage(
       "authorization:github:success:" + JSON.stringify({ token: token, provider: "github" }),
       TARGET
     );
     window.close();`,
    env.CMS_ORIGIN
  );

  return html(body, { ...extraHeaders, "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'" });
}

// Report a failure the same way Decap expects, so it shows the message in the
// admin page instead of a silent stall.
function problem(message, env) {
  const safeMessage = escapeHtml(message);
  const script = env && env.CMS_ORIGIN
    ? `if (window.opener) {
         window.opener.postMessage(
           "authorization:github:error:" + JSON.stringify({ message: ${json(message)} }),
           ${json(env.CMS_ORIGIN)}
         );
         window.close();
       }`
    : "";

  const body = page(
    "Sign-in problem",
    `<h1>Sign-in problem</h1>
     <p>${safeMessage}</p>
     <p>Return to <a href="/">the content manager</a> and try again.</p>`,
    script,
    env && env.CMS_ORIGIN
  );

  return html(body, { "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'" });
}

function page(title, content, script, origin) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
${content}
<script>
  (function () {
    var TARGET = ${json(origin || "")};
    ${script}
  })();
</script>
</body>
</html>`;
}

function missingConfig(env) {
  if (!env.CMS_ORIGIN) {
    return "CMS_ORIGIN is not set on this Worker, so it does not know which page to hand the token to.";
  }
  if (!env.GITHUB_CLIENT_ID) return "GITHUB_CLIENT_ID is not set on this Worker.";
  if (!env.GITHUB_CLIENT_SECRET) return "GITHUB_CLIENT_SECRET is not set on this Worker.";
  return null;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function html(body, extraHeaders) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // These pages carry a live access token: never let one sit in a cache.
      "cache-control": "no-store, private",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      ...extraHeaders,
    },
  });
}

// Serialise for safe embedding inside a <script> block. Escaping "<" is what
// stops a "</script>" inside a value from closing the tag early.
function json(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}
