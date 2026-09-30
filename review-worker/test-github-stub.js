#!/usr/bin/env node
/**
 * A stand-in for the GitHub Contents API, for `test.sh`.
 *
 * The dashboard's write path is the part most worth testing and the part that
 * cannot be tested with a fake R2, because it depends on real GitHub behaviour:
 * base64 bodies, a `sha` that has to match or the write is refused, a 422 when a
 * create would overwrite, and a directory listing that is 404 rather than empty
 * when the path is wrong. A mock that hand-answers those would only test the
 * mock.
 *
 * So this implements the subset of the real API that `lib/repository.js` uses,
 * in memory, with those rules kept:
 *
 *   GET  /repos/:owner/:repo/contents/:path?ref=  → the file, or 404
 *   GET  /repos/:owner/:repo/contents/:path       → a directory listing
 *   PUT  /repos/:owner/:repo/contents/:path       → create, or update by sha
 *
 * The rules it keeps are the ones the dashboard relies on to fail closed:
 *
 *   - a GET of a missing file is 404, which `readTextFile` treats as `missing`
 *   - a GET of a missing *directory* is also 404, which `listAssociateIds`
 *     treats as "could not check" rather than "there are none"
 *   - a PUT without a `sha` onto an existing file is 422
 *   - a PUT with a stale `sha` is 409
 *   - a PUT with a correct `sha` replaces the content and issues a new sha
 *
 * It is only reachable from the test Worker, and only on localhost. Nothing in
 * `wrangler.toml` points at it and no production variable names it.
 *
 * Test-only fault injection, used to exercise the refusal paths:
 *
 *   POST /__stub/fail   {"mode":"unavailable"|"unauthorised"|"conflict"}  → next writes fail
 *   POST /__stub/reset  {}                                              → clear files and faults
 *   POST /__stub/import {"files":{path: content}}                       → restore a snapshot
 *   GET  /__stub/export                                             → the whole store
 *   GET  /__stub/state                                             → what is stored
 *
 * `export` and `import` exist because a suite has to take the repository away
 * for a while — to test what happens when the vocabulary is missing, say — and
 * put it back exactly as it was. Resetting and re-running the earlier
 * approvals would not be the same thing: those steps assert on the specific
 * records the earlier sections created.
 *
 * Start it with:  node test-github-stub.js [port]
 */

import { createServer } from "node:http";

const port = Number(process.argv[2] || 8803);

/** `path` → `{ content: Buffer, sha: string }`. */
const files = new Map();

/**
 * A sticky fault, applied to reads and writes alike, because the failures that
 * matter are not only the write that gets refused but the directory read that
 * comes first.
 *
 * "ok"          - nothing is wrong.
 * "unavailable" - 503, on reads and writes.
 * "unauthorised"- 401, on reads and writes.
 * "conflict"    - 409, on reads and writes.
 * "stale"       - 409, on writes only: reads work, the write is refused as an
 *                 out-of-date sha. This is the case where the record is already
 *                 known to be private, so a conflict is a conflict about the
 *                 write rather than an inability to check for duplicates.
 */
let writeFault = "ok";
// Every ref this stand-in was asked for, in order. The branch is meant to be
// server-side only, so the tests read this back to prove the request body had no
// say in it.
const refs = [];

// The headers the `/user` call was actually sent, so a suite can assert on the
// request rather than on whatever the Worker chose to report about it.
let lastUserHeaders = null;

/** Blobs are not content-addressed here; the sha only has to change on write. */
let shaCounter = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);

  readBody(request)
    .then((body) => handle(request, response, url, segments, body))
    .catch((error) => send(response, 500, { message: String(error?.message || error) }));
});

function handle(request, response, url, segments, body) {
  // ---- Test control ------------------------------------------------------
  if (segments[0] === "__stub") return stubControl(request, response, segments, body);

  // ---- The identity endpoint ---------------------------------------------
  // The sign-in path asks GitHub who signed in, and a header missing there is
  // invisible in a response-body assertion: GitHub answers 403 to a request with
  // no `User-Agent`, which the Worker reports as "the account name could not be
  // read". So the headers it was actually sent are recorded and returned here, and
  // the suite asserts on those rather than on any outcome.
  if (segments[0] === "user" && segments.length === 1) {
    lastUserHeaders = { ...request.headers };
    return send(response, 200, { login: "mwamer", id: 1 });
  }

  // ---- The Contents API --------------------------------------------------
  if (segments[0] !== "repos" || segments[3] !== "contents") {
    return send(response, 404, { message: "Not Found" });
  }

  const path = decodeURIComponent(segments.slice(4).join("/"));
  // A read names the branch with `?ref=`, but a write puts it in the body, so
  // reading only the query string would record every write as `main` and hide a
  // write aimed at the wrong branch. The body is the authoritative ref for a
  // PUT, and this is the only thing standing between a test write and `main`.
  // `readBody` already parsed the JSON, so `body` is an object. A read names
  // the branch with `?ref=`, but a write puts it in the body, and reading only
  // the query string would log every write as `main` and hide a write aimed at
  // the wrong branch.
  let ref = url.searchParams.get("ref");
  if (request.method === "PUT" && body && typeof body.branch === "string") {
    ref = body.branch;
  }
  ref = ref || "main";
  refs.push({ method: request.method, ref, path });

  if (request.method === "GET") return get(response, path, ref);
  if (request.method === "PUT") return put(response, path, body, ref);
  return send(response, 405, { message: "Method Not Allowed" });
}

function get(response, path, ref) {
  // "stale" is the one fault that is not a fault: it models a write whose sha no
  // longer matches, so reads must still succeed and only the write is refused.
  if (writeFault !== "ok" && writeFault !== "stale") return fault(response, writeFault);

  // A path that is a prefix of a stored file is a directory.
  const asDirectory = [...files.keys()].filter((key) => key.startsWith(`${path}/`));
  if (asDirectory.length > 0) {
    const prefix = `${path}/`;
    const names = new Set(asDirectory.map((key) => key.slice(prefix.length).split("/")[0]));
    return send(
      response,
      200,
      [...names]
        .sort()
        .map((name) => ({ name, path: `${prefix}${name}`, type: "file", size: 0 })),
      { "content-type": "application/json" }
    );
  }

  const file = files.get(path);
  // A missing file and a missing directory are the same 404, exactly as in the
  // real API. `listAssociateIds` and `readTextFile` tell them apart by what they
  // were asking for, not by the status.
  if (!file) return send(response, 404, { message: "Not Found" });

  return send(
    response,
    200,
    {
      name: path.split("/").pop(),
      path,
      sha: file.sha,
      size: file.content.length,
      // The real API wraps base64 at 60 columns; `readTextFile` strips the
      // newlines, so reproducing the wrapping keeps that code honest.
      content: wrap(file.content.toString("base64")),
      encoding: "base64",
    },
    { "content-type": "application/json" }
  );
}

function put(response, path, body, ref) {
  if (writeFault !== "ok") return fault(response, writeFault);

  const existing = files.get(path);

  // GitHub refuses a create that would overwrite, and refuses an update whose
  // sha is stale. Both are what the dashboard reports as a conflict.
  if (body.sha === undefined && existing) {
    return send(response, 422, { message: "Validation Failed", errors: [{ code: "already_exists" }] });
  }
  if (body.sha !== undefined && (!existing || existing.sha !== body.sha)) {
    return send(response, 409, { message: "Conflict" });
  }

  shaCounter += 1;
  const sha = `sha-${shaCounter}`;
  files.set(path, { content: Buffer.from(String(body.content || ""), "base64"), sha });

  return send(
    response,
    existing ? 200 : 201,
    { content: { path, sha }, commit: { message: body.message || null } },
    { "content-type": "application/json" }
  );
}

function fault(response, mode) {
  if (mode === "unauthorised") return send(response, 401, { message: "Bad credentials" });
  if (mode === "conflict" || mode === "stale") return send(response, 409, { message: mode === "stale" ? "is at 1111111 but expected 2222222" : "Conflict" });
  return send(response, 503, { message: "Service Unavailable" });
}

function stubControl(request, response, segments, body) {
  const action = segments[1];

  if (action === "fail" && request.method === "POST") {
    writeFault = body.mode || "ok";
    return send(response, 200, { writeFault });
  }
  if (action === "reset" && request.method === "POST") {
    files.clear();
    refs.length = 0;
    writeFault = "ok";
    return send(response, 200, { files: 0 });
  }
  if (action === "seed" && request.method === "POST") {
    // Seed a file, for the tests that need an existing record or vocabulary.
    if (!body.path || typeof body.path !== "string") {
      return send(response, 400, { message: "seed needs a path" });
    }
    files.set(body.path, {
      content: Buffer.from(String(body.content ?? ""), "utf8"),
      sha: body.sha || `seed-${files.size + 1}`,
    });
    return send(response, 200, { path: body.path, files: files.size });
  }
    if (action === "user-headers" && request.method === "GET") {
      return send(response, 200, { headers: lastUserHeaders });
    }
    if (action === "state" && request.method === "GET") {
      return send(
        response,
        200,
        {
          writeFault,
        refs: [...refs],
        files: [...files.keys()].sort(),
        shas: Object.fromEntries([...files].map(([path, file]) => [path, file.sha])),
      },
      { "content-type": "application/json" }
    );
  }
  if (action === "export" && request.method === "GET") {
    return send(
      response,
      200,
      {
        writeFault,
        files: Object.fromEntries(
          [...files].map(([path, file]) => [path, file.content.toString("base64")])
        ),
      },
      { "content-type": "application/json" }
    );
  }
  if (action === "import" && request.method === "POST") {
    files.clear();
    writeFault = body.writeFault || "ok";
    for (const [path, content] of Object.entries(body.files || {})) {
      files.set(path, { content: Buffer.from(String(content), "base64"), sha: `restored-${files.size + 1}` });
    }
    return send(response, 200, { files: files.size });
  }
  return send(response, 404, { message: "Not Found" });
}

function send(response, status, payload, headers = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": headers["content-type"] || "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

/** Base64 wrapped at 60 characters, as the GitHub API returns it. */
function wrap(text) {
  return (text.match(/.{1,60}/g) || []).join("\n");
}

server.listen(port, "127.0.0.1", () => {
  console.log(`github stub listening on http://127.0.0.1:${port}`);
});
