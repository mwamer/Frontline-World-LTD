/**
 * Reading and writing the site's records in GitHub.
 *
 * ## Why this is not the oauth-proxy
 *
 * `oauth-proxy` hands a live GitHub token to the browser, because Decap commits
 * with it and the protocol has nowhere else to put the credential. A dashboard
 * that only reads pages has no need for that, so `review-worker` never borrows
 * it. Now that the dashboard also *writes* the associate record, the question
 * comes back with more force, and the answer is the same: two credentials with
 * two jobs, never mixed.
 *
 *   the sign-in token   Scoped `read:user`, used once in the OAuth callback to
 *                       learn who signed in, then thrown away. It cannot reach
 *                       the repository. A reviewer never holds it.
 *   the repository      `REPOSITORY_TOKEN`, a Worker *secret*, held only in
 *     token             this module's environment. It never appears in a
 *                       response, a page, a log line or a redirect.
 *
 * A fine-grained personal access token scoped to this one repository, with
 * "Contents: read and write" and nothing else, is the shape that matches this.
 * A GitHub App installation token works the same way here.
 *
 * ## What a request from the browser may say
 *
 * Nothing. No route passes a path or a body through from the request: the path
 * is built here from a validated associate id, and the body is the record this
 * module serialises from data read out of R2. `assertWritablePath()` is the
 * backstop that makes "a reviewer could name any file" impossible rather than
 * merely unintended.
 *
 * ## Failing closed
 *
 * Every function returns a result object with an `ok` flag instead of throwing,
 * so a caller cannot accidentally treat an error as an empty list. That matters
 * most in `listAssociateIds()`: if the directory cannot be read, the answer is
 * "I could not check", never "there are none", because those two lead to
 * different outcomes — a refused approval versus a duplicate record that
 * overwrites a real person.
 *
 * ## Tests
 *
 * `GITHUB_API_BASE` points the module at a local stand-in for the Contents API
 * (`test-github-stub.js`) so the whole path — allowlist, base64, conflict
 * detection, error handling — is exercised without a network or a credential.
 * It is unset in production, where the base is api.github.com.
 */

/** Only these two shapes may ever be written. Nothing else in the repository. */
const WRITABLE_ASSOCIATE = /^data\/associates\/[a-z0-9][a-z0-9-]{0,63}\.yml$/;
const WRITABLE_IMAGE = /^static\/images\/[a-z0-9][a-z0-9-]{0,63}\.(jpg|jpeg|png|webp)$/;

/** Readable, because the vocabulary has to come from the one authoritative file. */
const READABLE_VOCABULARY = "data/vocab/associates.yml";

/** A short cache, so a page view does not spend a GitHub API call per field. */
const CACHE_TTL_MS = 15_000;

/** Listing a directory of this size never needs a second page. */
const MAX_DIRECTORY_ENTRIES = 1000;

export function apiBase(env) {
  return String(env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
}

export function branch(env) {
  return String(env.REPOSITORY_BRANCH || "main");
}

function headers(env) {
  const base = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "frontline-review-dashboard",
  };
  // A read of a public directory needs no credential, so the token is optional
  // for GET. Every write needs it, and `writeFile` refuses without one.
  if (env.REPOSITORY_TOKEN) base.authorization = `Bearer ${env.REPOSITORY_TOKEN}`;
  return base;
}

/**
 * Reject any path this Worker has no business touching.
 *
 * The allowlist is a regex, not a check the caller performs, so a new route
 * cannot forget it. It runs on the path as built by the server, which is itself
 * built from a validated id — the two together mean neither a caller nor a
 * request can name a file outside these two folders.
 */
export function assertWritablePath(path) {
  if (typeof path !== "string") return false;
  if (path.includes("..") || path.startsWith("/") || path.includes("\\")) return false;
  return WRITABLE_ASSOCIATE.test(path) || WRITABLE_IMAGE.test(path);
}

export function associatePath(associateId) {
  return `data/associates/${associateId}.yml`;
}

export function imagePath(name) {
  return `static/images/${name}`;
}

/**
 * The associate ids currently in `data/associates/`.
 *
 * Returns `{ ok: true, ids }` on success and `{ ok: false, reason }` when the
 * directory could not be read. Callers must check `ok`; an empty `ids` array is
 * a real answer and an unavailable repository is not.
 */
export async function listAssociateIds(env, { fresh = false } = {}) {
  const path = "data/associates";
  // A caller that is about to write needs the answer as it is now, not as it was
  // a few seconds ago: the whole point of this list is to know what is already
  // there, and a stale list is a duplicate waiting to happen.
  const cached = fresh ? null : readCache(dirKey(env, path));
  if (cached) return cached;

  const response = await request(env, `repos/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch(env))}`);

  if (response.status === 404) {
    // The folder is part of the repository, so this means something is wrong
    // with the path or the token rather than "nobody is an associate yet".
    return unusable("The associates directory could not be found in the repository.");
  }
  if (!response.ok) {
    return unreachable(describeHttpFailure(response, "the list of existing associates"));
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return unusable("The repository returned something that is not JSON.");
  }
  if (!Array.isArray(body)) {
    return unusable("The repository did not return a directory listing.");
  }

  const ids = body
    .filter((entry) => entry && typeof entry.name === "string")
    .map((entry) => entry.name.replace(/\.ya?ml$/, ""))
    .filter((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id));

  return writeCache(dirKey(env, path), { ok: true, ids });
}

/**
 * One file, as text.
 *
 * `{ ok: true, missing: true }` means the repository answered 404 for the file
 * itself, which is a normal answer when creating something new. That is kept
 * distinct from a transport or authorisation failure, which is never `ok`.
 */
export async function readTextFile(env, path, { fresh = false } = {}) {
  if (path !== READABLE_VOCABULARY && !assertWritablePath(path)) {
    return unreachable("That path is not one this dashboard reads.");
  }

  const key = fileKey(env, path);
  if (!fresh) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  const response = await request(
    env,
    `repos/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch(env))}`
  );

  if (response.status === 404) {
    return { ok: true, missing: true, text: null, sha: null };
  }
  if (!response.ok) {
    return unreachable(describeHttpFailure(response, `the file ${path}`));
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return unusable(`The repository returned something unreadable for ${path}.`);
  }
  if (typeof body?.content !== "string") {
    return unusable(`The repository returned no content for ${path}.`);
  }

  let text;
  try {
    text = decodeBase64(body.content.replace(/\n/g, ""));
  } catch {
    return unusable(`The content of ${path} could not be decoded.`);
  }

  const result = { ok: true, missing: false, text, sha: body.sha || null };
  return writeCache(key, result);
}

/**
 * Whether a file exists, and its blob sha.
 *
 * Used to make a retry work: a photograph written to the repository but not yet
 * linked to a record needs its sha, or the retry looks like a create and GitHub
 * refuses it. Only the sha is returned — the bytes are never decoded, since a
 * photograph read as text would come back mangled.
 */
export async function readFileSha(env, path) {
  if (!assertWritablePath(path)) {
    return unreachable("That path is not one this dashboard reads.");
  }

  const response = await request(
    env,
    `repos/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch(env))}`
  );

  if (response.status === 404) return { ok: true, missing: true, sha: null };
  if (!response.ok) return unreachable(describeHttpFailure(response, `the file ${path}`));

  let body;
  try {
    body = await response.json();
  } catch {
    return unusable(`The repository returned something unreadable for ${path}.`);
  }
  return { ok: true, missing: false, sha: body?.sha || null };
}

/**
 * Write text, creating or updating.
 *
 * `sha` is the blob the edit was based on. Passing it makes GitHub reject the
 * write if the file changed in between, so two reviewers acting at once cannot
 * silently overwrite each other: the second gets a conflict and is told so,
 * rather than losing the first edit. Omitting it creates the file, and GitHub
 * refuses if it already exists.
 */
export async function writeTextFile(env, path, text, { message, sha = null } = {}) {
  if (!assertWritablePath(path)) {
    return unreachable("That path is not one this dashboard writes.");
  }
  if (!env.REPOSITORY_TOKEN) {
    return unreachable("No repository token is configured on this dashboard.");
  }

  return putContents(env, path, encodeBase64(String(text)), message, sha);
}

/**
 * Write a binary file, the same way, for a photograph.
 *
 * `sha` is optional for the same reason it is on `writeTextFile`: a photograph
 * that was written but never linked to a record, because the second write
 * failed, has to be retryable. Passing the existing blob's sha turns the retry
 * into an update instead of a create that GitHub would refuse.
 */
export async function writeBinaryFile(env, path, bytes, { message, sha = null } = {}) {
  if (!assertWritablePath(path)) {
    return unreachable("That path is not one this dashboard writes.");
  }
  if (!env.REPOSITORY_TOKEN) {
    return unreachable("No repository token is configured on this dashboard.");
  }
  return putContents(env, path, encodeBase64(bytes), message, sha);
}

async function putContents(env, path, content, message, sha) {
  const payload = { message, content, branch: branch(env) };
  if (sha) payload.sha = sha;

  const response = await request(env, `repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (response.status === 409 || response.status === 422) {
    // GitHub answers 422 for a create that would overwrite, and 409 for a
    // sha that no longer matches. Both mean the same thing to a reviewer.
    return {
      ok: false,
      kind: "conflict",
      reason: "The file changed in the repository while you were reviewing. Nothing was written; reload and try again.",
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      kind: "unauthorised",
      reason: "The repository token was refused, so nothing was written. Check REPOSITORY_TOKEN.",
    };
  }
  if (!response.ok) {
    return unreachable(describeHttpFailure(response, `the write to ${path}`));
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // A successful write with an unreadable body is still a write.
  }
  invalidate(fileKey(env, path));
  invalidate(dirKey(env, "data/associates"));
  return { ok: true, sha: body?.content?.sha || null, path };
}

/**
 * The controlled vocabulary, read from the one authoritative file.
 *
 * `data/vocab/associates.yml` is the only place a term is written, so it is the
 * only place the dashboard reads. Parsing the ids out of it here means a term
 * added to the vocabulary reaches new associate records with no change to any
 * JavaScript — which is the whole point of having one list.
 */
export async function readVocabulary(env, { fresh = false } = {}) {
  const file = await readTextFile(env, READABLE_VOCABULARY, { fresh });
  if (!file.ok) return file;
  if (file.missing) {
    return unusable(`The repository has no ${READABLE_VOCABULARY}.`);
  }

  const vocabulary = parseVocabulary(file.text);
  if (!vocabulary) {
    // Refusing to guess is the point. A parser that returned an empty list here
    // would strip every tag from every record it approved.
    return unusable(`The vocabulary in ${READABLE_VOCABULARY} could not be read.`);
  }
  return { ok: true, vocabulary };
}

/**
 * Pull the `id` values out of the five lists in the vocabulary file.
 *
 * A focused reader rather than a YAML library: the file is a list of `- id:` /
 * `label:` pairs under five known top-level keys, and adding a dependency to
 * parse one known file in a Worker is not a trade worth making. Anything this
 * reader does not recognise is ignored, and an unrecognised shape yields null
 * rather than a partial list.
 */
export function parseVocabulary(text) {
  const source = String(text || "");
  if (!source.trim()) return null;

  const lists = {};
  let current = null;
  let sawTopLevelKey = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const topLevel = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (topLevel) {
      current = topLevel[1];
      sawTopLevelKey = true;
      if (!lists[current]) lists[current] = [];
      continue;
    }

    const idEntry = line.match(/^\s+-\s+id:\s*"?([A-Za-z0-9][A-Za-z0-9_-]*)"?\s*$/);
    if (idEntry && current) {
      lists[current].push(idEntry[1]);
      continue;
    }

    // A `- id:` with something after it, or a `label:` before any `id:`, means
    // the file is not the shape this reader knows. Better to say so than to
    // hand back a list that is quietly short.
    if (current && /^\s+-\s+id:/.test(line) && !idEntry) return null;
  }

  const required = ["expertise", "roles", "contributions", "sectors", "regions"];
  if (!sawTopLevelKey) return null;
  if (required.some((key) => !Array.isArray(lists[key]) || lists[key].length === 0)) return null;

  return {
    expertise: lists.expertise,
    roles: lists.roles,
    contributions: lists.contributions,
    sectors: lists.sectors,
    regions: lists.regions,
  };
}

// ---- Transport --------------------------------------------------------------

async function request(env, path, init = {}) {
  // The caller's headers are merged over the defaults rather than replaced, so
  // a `content-type` on a write survives alongside the accept and auth headers.
  const merged = { ...headers(env), ...(init.headers || {}) };
  try {
    const response = await fetch(`${apiBase(env)}/${path}`, {
      ...init,
      headers: merged,
      // `manual` rather than a follow, so a redirect is visible as a failure
      // instead of quietly re-sending the `authorization` header somewhere the
      // dashboard did not intend. The Contents API does not redirect for these
      // paths, so a 3xx means the base is wrong.
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        status: response.status,
        _reason: `unexpected redirect to ${response.headers.get("location") || "somewhere else"}`,
        json: async () => ({}),
        text: async () => "",
      };
    }
    return response;
  } catch (error) {
    // A transport failure is returned in the same shape as a response, so every
    // caller handles "could not reach it" through its existing `ok` check rather
    // than through a try/catch it might forget.
    return {
      ok: false,
      status: 0,
      _reason: String(error?.message || error),
      json: async () => ({}),
      text: async () => "",
    };
  }
}

function describeHttpFailure(response, what) {
  if (response._reason) return `${capitalise(what)} could not be reached: ${response._reason}.`;
  if (response.status === 404) return `${capitalise(what)} was not found in the repository.`;
  if (response.status === 401 || response.status === 403) {
    return `${capitalise(what)} was refused. The repository token may be missing or out of scope.`;
  }
  if (response.status === 429) return `${capitalise(what)} hit the GitHub rate limit. Try again shortly.`;
  return `${capitalise(what)} could not be read from the repository (HTTP ${response.status}).`;
}

/**
 * The repository did not answer us: a transport failure, a 5xx, or a refusal.
 *
 * Callers report this as a service problem of their own (503), because nothing
 * about the content is wrong — we simply cannot see it, so nothing may change.
 */
function unreachable(reason) {
  return { ok: false, kind: "unreachable", reason };
}

/**
 * The repository answered, and what it answered cannot be used: a file that is
 * not there, a body of the wrong shape, content that will not decode or parse.
 *
 * This is a content fault rather than an outage, so callers report it as 502.
 * The distinction matters to whoever gets paged: one is "GitHub is unwell, or our
 * token is wrong", the other is "the repository is not in the state we need".
 */
function unusable(reason) {
  return { ok: false, kind: "unusable", reason };
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---- base64 -----------------------------------------------------------------

function encodeBase64(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---- A small cache ----------------------------------------------------------

/**
 * Module-scoped, because a Worker isolate is reused between requests. It is
 * only ever a cache of the repository's current state, never of an application,
 * and a write invalidates its own entry — so a stale read can delay a decision
 * by a few seconds at most, never contradict the audit trail in R2.
 */
const cache = new Map();

/** The repository a cache entry belongs to, so a test can repoint the base. */
function dirKey(env, path) {
  return `dir:${env.GITHUB_REPO || ""}@${apiBase(env)}:${path}`;
}

function fileKey(env, path) {
  return `file:${env.GITHUB_REPO || ""}@${apiBase(env)}:${branch(env)}:${path}`;
}

function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.at + CACHE_TTL_MS < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

function invalidate(key) {
  cache.delete(key);
}

/** Test seam: drop the cache so a sequence of writes is not served from memory. */
export function clearRepositoryCache() {
  cache.clear();
}
