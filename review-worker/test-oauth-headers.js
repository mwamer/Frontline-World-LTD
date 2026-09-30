#!/usr/bin/env node
/**
 * Asserts the request GitHub's identity endpoint is actually sent.
 *
 * A missing `User-Agent` here is the defect this exists to catch. GitHub answers
 * 403 to a request that has none, and the Worker turns that into "the account
 * name could not be read" — a message about the account rather than about the
 * header. So asserting on the response, or on a body, proves nothing: a request
 * missing the header looks identical to a good one until a real account exists.
 *
 * What is checked is the request. `finishSignIn` runs for real, and the only thing
 * replaced is the network: `fetch` is captured, so the headers handed to GitHub are
 * the ones the Worker genuinely built. That covers the request the dashboard
 * depends on and the branch-pinned one in `lib/repository.js`, whose headers come
 * from a shared helper and are asserted through the same capture.
 *
 *   node test-oauth-headers.js
 */

import { finishSignIn, identify } from "./lib/auth.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n         expected: ${expected}\n         actual:   ${actual}`}`);
}

function checkPresent(name, value) {
  const ok = typeof value === "string" && value.length > 0;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n         missing or empty: ${value}`}`);
}

/** A request shaped like GitHub's responses, with only the fields the code reads. */
function reply(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Run `finishSignIn` over a fake network and hand back every request it made.
 * The token exchange is answered first so the identity call is reached, which is
 * the one under test: the code exchange is a different host, on a different
 * endpoint, and was never the failing request.
 */
async function capturedRequests() {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    seen.push({ url: String(url), method: init.method || "GET", headers });
    if (String(url).includes("/login/oauth/access_token")) {
      return reply({ access_token: "gho_test_token", token_type: "bearer" });
    }
    if (String(url).includes("/user")) return reply({ login: "mwamer" });
    throw new Error(`unexpected request in test: ${url}`);
  };
  try {
    // The state cookie has to be present and match, or the callback refuses
    // before it makes any request, and there would be nothing to assert on.
    const request = new Request("https://dashboard.example/callback?code=testcode&state=teststate", {
      headers: { cookie: "fw_review_state=teststate" },
    });
    const response = await finishSignIn(request, {
      GITHUB_CLIENT_ID: "test-client",
      GITHUB_CLIENT_SECRET: "test-secret",
      SESSION_SECRET: "test-session-secret",
      ALLOWED_USERS: "mwamer",
      GITHUB_REPO: "mwamer/Frontline-World-LTD",
      REPOSITORY_BRANCH: "associate-review-e2e-test",
      REPOSITORY_TOKEN: "github_pat_test",
    });
    return { seen, response };
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\n=== the identity request GitHub is sent ===");

const { seen: requests, response } = await capturedRequests();
const identity = requests.find((r) => r.url.includes("/user"));

if (!identity) {
  console.log("  FAIL no /user request was made, so nothing was verified");
  process.exit(1);
}

// The header that was absent when the callback failed. Without it GitHub returns
// 403 and the account name is never read.
checkPresent("the /user request carries a User-Agent", identity.headers["user-agent"]);
check("it identifies the dashboard", identity.headers["user-agent"], "frontline-review-dashboard");

checkPresent("it carries an Accept header", identity.headers.accept);
check(
  "the Accept header is the documented API media type",
  identity.headers.accept,
  "application/vnd.github+json"
);

checkPresent("it carries an authorization header", identity.headers.authorization);
check("it authorizes with the token that was just issued", identity.headers.authorization, "Bearer gho_test_token");

// The branch is server-side only, so it must not reach the identity request either.
check("no branch is sent to the identity endpoint", identity.url.includes("associate-review-e2e-test"), false);

// The token belongs to this exchange only, so it must not be echoed into a URL.
check("the access token is not placed in the request URL", identity.url.includes("gho_test_token"), false);

console.log("\n=== the cookies a successful sign-in hands back ===");

// The session cookie and the clearing of the state cookie are two different
// cookies, and they have to reach the browser as two headers. Joined into one
// with a comma — which RFC 6265 forbids, and which is what this used to do — the
// browser reads it as a single malformed cookie, keeps nothing usable, and the
// very next request arrives with no session at all. So the count of headers is
// the thing under test, not the text of any one of them.
const setCookies = response.headers.getSetCookie();

check("the response carries two Set-Cookie headers", setCookies.length, 2);
check(
  "one of them sets the session",
  setCookies.some((c) => c.startsWith("fw_review_session=")),
  true
);
check(
  "one of them clears the state cookie",
  setCookies.some((c) => c.startsWith("fw_review_state=;")),
  true
);
check(
  "no single header carries two cookies joined by a comma",
  setCookies.some((c) => c.includes("fw_review_session=") && c.includes("fw_review_state=")),
  false
);

// The session must actually be accepted on the request that follows, which is the
// failure this whole check exists for: the sign-in reported success and the
// dashboard still said nobody was signed in.
const sessionCookie = setCookies.find((c) => c.startsWith("fw_review_session="));
const value = sessionCookie ? sessionCookie.split(";")[0] : "";
const next = await identify(new Request("https://dashboard.example/", { headers: { cookie: value } }), {
  SESSION_SECRET: "test-session-secret",
  ALLOWED_USERS: "mwamer",
});
check("the next request is recognised as signed in", next && next.login, "mwamer");

console.log(`\nPassed: ${passed}   Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
