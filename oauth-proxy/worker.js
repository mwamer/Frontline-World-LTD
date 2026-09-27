/**
 * Decap CMS GitHub OAuth proxy for Frontline World.
 *
 * A static site cannot hold a GitHub OAuth client secret, so Decap sends the
 * editor here instead. The proxy holds the secret, performs the code-for-token
 * exchange, and hands the token back to the admin page via postMessage.
 *
 * Deploy with:  npx wrangler deploy
 * Secrets:      npx wrangler secret put GITHUB_CLIENT_SECRET
 *               npx wrangler secret put GITHUB_CLIENT_ID
 * Optional:     npx wrangler secret put ALLOWED_USERS   (comma-separated GitHub usernames)
 *
 * The GitHub OAuth App's Authorization callback URL must be exactly
 * <worker-host>/callback, where <worker-host> is this Worker's hostname.
 */

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";

// `repo` would grant the minted token control of every public *and private*
// repository on the account. This site only needs its own public repository, so
// the narrow scopes are requested instead. If Decap ever rejects the login for
// insufficient scope, change this to "repo user" -- that is the documented
// fallback, and it widens access to all private repositories.
const SCOPES = "public_repo user";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") return authorize(url, env);
    if (url.pathname === "/callback") return exchange(url, env);

    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

// Step 1: bounce the editor to GitHub's consent screen.
function authorize(url, env) {
  if (!env.GITHUB_CLIENT_ID) return problem("GITHUB_CLIENT_ID is not set on this Worker.");

  const redirectUri = `${url.origin}/callback`;
  const target = new URL(GITHUB_AUTHORIZE);
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("scope", SCOPES);
  target.searchParams.set("redirect_uri", redirectUri);
  // Decap generates the state and verifies it on the way back, so it must
  // survive the round trip untouched.
  const state = url.searchParams.get("state");
  if (state) target.searchParams.set("state", state);

  return Response.redirect(target.toString(), 302);
}

// Step 2: swap the one-time code for an access token, then hand it to the
// admin window. Never log the code or the token.
async function exchange(url, env) {
  const error = url.searchParams.get("error");
  if (error) {
    return problem(`GitHub returned an error: ${url.searchParams.get("error_description") || error}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return problem("No authorization code was returned by GitHub.");
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return problem("GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is not set on this Worker.");
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

  if (!tokenResponse.ok) return problem(`GitHub rejected the token request (HTTP ${tokenResponse.status}).`);

  const payload = await tokenResponse.json();
  if (!payload.access_token) {
    return problem(payload.error_description || "GitHub did not return an access token.");
  }

  if (env.ALLOWED_USERS) {
    const allowed = env.ALLOWED_USERS.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
    const userResponse = await fetch(GITHUB_USER, {
      headers: { authorization: `Bearer ${payload.access_token}`, accept: "application/vnd.github+json" },
    });

    if (!userResponse.ok) {
      return problem("Signed in to GitHub, but could not read the account name to check the editor list.");
    }

    const login = ((await userResponse.json()).login || "").toLowerCase();
    if (!allowed.includes(login)) {
      return problem(
        `${login} is not on this CMS's editor list. Ask the repository owner to add you, then sign in again.`
      );
    }
  }

  return html(postMessagePage(payload.access_token, state));
}

// Decap listens for this message on the window that opened the popup.
function postMessagePage(token, state) {
  const safeToken = JSON.stringify(token);
  const safeState = JSON.stringify(state || "");

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signing in</title></head>
<body>
<p>Signing in to Frontline World content manager. You can close this window if it does not close itself.</p>
<script>
  (function () {
    var payload = { token: ${safeToken}, provider: "github", state: ${safeState} };
    if (window.opener) {
      window.opener.postMessage(payload, window.location.origin);
      window.close();
    } else {
      document.body.textContent = "Sign-in window lost its opener. Return to /admin and try again.";
    }
  })();
</script>
</body>
</html>`;
}

function html(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The body carries a live access token: never let it sit in a cache.
      "cache-control": "no-store, private",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  });
}

function problem(message) {
  return html(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign-in problem</title></head>
<body>
<h1>Sign-in problem</h1>
<p>${escapeHtml(message)}</p>
<p>Return to <a href="/admin/">the content manager</a> and try again.</p>
</body>
</html>`);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}
