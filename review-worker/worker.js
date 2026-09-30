/**
 * Associate application review and approval dashboard for Frontline World.
 *
 * The intake path already exists and is not touched by anything here:
 * `/become-an-associate/` → applications-worker → private R2. This Worker is
 * the other half — the protected side of that bucket, where a reviewer reads an
 * application, approves it, and decides whether the person is published.
 *
 * What it does:
 *
 *   GET  /login                      a page with a sign-in button
 *   POST /logout                     end the session
 *   GET  /auth, /callback            the GitHub OAuth exchange
 *   GET  /                           the application list, newest first
 *   GET  /application/:id            one application, in review sections
 *   GET  /file/:id                   a CV or photograph, streamed to a reviewer
 *   POST /application/:id/approve    Approve & Create Associate
 *   POST /application/:id/status     change the status, with a note
 *   POST /application/:id/note       add an internal note
 *   POST /application/:id/photo      publish the applicant's photograph
 *   POST /application/:id/publication  publish or unpublish the profile
 *
 * The properties that matter, and where they come from:
 *
 *   Nothing is readable without a session.  Every route below the sign-in
 *   handlers calls `identify()` first and answers 401 or redirects. An
 *   application id is not a credential, and knowing one gets a visitor nothing.
 *
 *   The GitHub token from sign-in never reaches a page. The OAuth exchange keeps
 *   it in this Worker, uses it once with `read:user` to read the account name,
 *   and discards it. What a reviewer carries is a signed cookie holding their
 *   username. The token that writes to the repository is a different credential
 *   entirely — a Worker secret read only by `lib/repository.js`, never returned
 *   to anyone. This is why `oauth-proxy` cannot be reused: it exists to hand a
 *   token to Decap, which is the opposite requirement.
 *
 *   Consent is read, never collected.  `lib/publication.js` re-reads the
 *   application from R2 on every publication request and refuses unless the
 *   stored answer is yes. No route accepts consent from a request, so a reviewer
 *   cannot publish someone who declined, whatever the CMS record says.
 *
 *   Approval is not publication.  `lib/approval.js` creates the record private
 *   and inactive. Putting someone on the website is a second, separate decision
 *   that re-checks consent from storage.
 *
 *   The browser never names a file.  Paths are built from a validated associate
 *   id inside `lib/repository.js`, which also refuses any path outside the two
 *   folders it is allowed to write. Record content is serialised here from data
 *   read out of R2; no route accepts YAML from a request.
 *
 * Deploy with:  npx wrangler deploy
 * Secrets:      GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET,
 *               REPOSITORY_TOKEN
 * Vars:         ALLOWED_USERS, GITHUB_REPO, REPOSITORY_BRANCH
 */

import {
  identify, startSignIn, finishSignIn, signOut, testSession, testExpiredSession,
  csrfToken, verifyCsrf, SESSION_COOKIE,
} from "./lib/auth.js";
import {
  listApplications, readApplication, readReview, saveReview, emptyReview,
  withNote, validApplicationId, readRetentionReport, STATUSES,
} from "./lib/store.js";
import { approveAndCreate } from "./lib/approval.js";
import { setPublication } from "./lib/publication.js";
import { publishPhotograph } from "./lib/photograph.js";
import { runSweep } from "./lib/cleanup.js";
import { readTextFile, associatePath } from "./lib/repository.js";
import { readYamlScalar } from "./lib/associate.js";
import { listPage, reviewPage, loginPage, errorPage } from "./lib/views.js";

/** Where a reviewer is sent after a sign-in that needed a redirect. */
const HOME = "/";

export default {
  /**
   * The daily retention sweep, from the Cron Trigger in `wrangler.toml`.
   *
   * Awaited rather than handed to `waitUntil`, because a cron invocation is
   * finished when this returns and the whole point of the report is that it was
   * written. Failures are collected into the report rather than thrown, so one
   * bad application does not abort the rest of the sweep; only a failure to
   * write the report itself is logged, because that is the last place it can go.
   */
  async scheduled(controller, env) {
    const report = await runSweep(env);
    console.log(JSON.stringify({
      event: "retention_sweep",
      at: report.at,
      scanned: report.scanned,
      deleted: report.deleted,
      uploadsDiscarded: report.uploadsDiscarded,
      kept: report.kept,
      needsReview: report.needsReview,
      failures: report.failures.length,
    }));
    for (const failure of report.failures) {
      console.error(JSON.stringify({ event: "retention_sweep_failure", ...failure }));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Sign-in handlers run before anything else, because they are the only
    // routes that do not need a session.
    if (path === "/auth") return startSignIn(request, env);
    if (path === "/callback") return finishSignIn(request, env);
    if (path === "/login") {
      if (await identify(request, env)) return redirect(HOME);
      return loginPage({ flash: url.searchParams.get("error") || null });
    }
    // Signing out ends the session, so it is a POST like the others and carries a
    // token. A request that fails the check still gets the cookie cleared: the
    // worst case for a stale token is that a reviewer has to sign in again, and
    // refusing to clear it would leave them stuck signed in.
    if (path === "/logout") {
      if (request.method !== "POST") return redirect("/login");
      const session = await identify(request, env);
      const form = await readForm(request);
      if (session && (await verifyCsrf(env, session.login, form.get("csrf")))) {
        console.log(JSON.stringify({ event: "signed_out", reviewer: session.login }));
      }
      return signOut();
    }

    // The stylesheet is public and carries no applicant data, so it is served
    // before the session check to keep a login page styled.
    if (path === "/review.css") return stylesheet();

    // Test-only session minting. ALLOW_TEST_RESET is in the git-ignored
    // .dev.vars and not in wrangler.toml, so a deployed Worker has no such
    // route. The cookie returned still has to pass the real identify() below.
    if (path === "/__test/session" && env.ALLOW_TEST_RESET === "true") {
      return mintTestSession(request, env, false);
    }
    if (path === "/__test/expired-session" && env.ALLOW_TEST_RESET === "true") {
      return mintTestSession(request, env, true);
    }
    if (path.startsWith("/__test/") && env.ALLOW_TEST_RESET === "true") {
      return new Response("Not found", plain(404));
    }

    // Everything else needs a reviewer.
    const login = await identify(request, env);
    if (!login) {
      // A browser gets the sign-in page; anything else gets a bare refusal, so
      // an unauthenticated client is never handed a hint that a record exists.
      if (acceptsHtml(request)) {
        return request.method === "GET"
          ? redirect("/login")
          : errorPage({ login: null, code: 401, title: "Not signed in", message: "Sign in to review applications." });
      }
      return new Response("Unauthorized", plain(401));
    }

    // One token per signed-in request. It is handed to every page, so the forms
    // rendered — including the one in the catch-all error page — always match
    // the session they belong to.
    const token = await csrfToken(env, login.login);

    try {
      if (path === "/" || path === "/index.html") {
        if (request.method !== "GET") return methodNotAllowed();
        const [rows, retention] = await Promise.all([listApplications(env), readRetentionReport(env)]);
        const filter = url.searchParams.get("status") || "all";
        return await listPage(rows, { login, filter, flash: null, token, retention });
      }

      const fileMatch = path.match(/^\/file\/([^/]+)$/);
      if (fileMatch) {
        if (request.method !== "GET") return methodNotAllowed();
        return await serveFile(env, decodeURIComponent(fileMatch[1]), url, login);
      }

      const applicationMatch = path.match(/^\/application\/([^/]+)$/);
      if (applicationMatch) {
        if (request.method !== "GET") return methodNotAllowed();
        return await showApplication(env, decodeURIComponent(applicationMatch[1]), {
          login,
          token,
          flash: url.searchParams.get("flash"),
          flashCode: url.searchParams.get("code"),
        });
      }

      const approveMatch = path.match(/^\/application\/([^/]+)\/approve$/);
      if (approveMatch) return await approveAction(request, env, decodeURIComponent(approveMatch[1]), login);

      const statusMatch = path.match(/^\/application\/([^/]+)\/status$/);
      if (statusMatch) return await changeStatus(request, env, decodeURIComponent(statusMatch[1]), login);

      const noteMatch = path.match(/^\/application\/([^/]+)\/note$/);
      if (noteMatch) return await addNote(request, env, decodeURIComponent(noteMatch[1]), login);

      const photoMatch = path.match(/^\/application\/([^/]+)\/photo$/);
      if (photoMatch) return await photographAction(request, env, decodeURIComponent(photoMatch[1]), login);

      const publicationMatch = path.match(/^\/application\/([^/]+)\/publication$/);
      if (publicationMatch) return await publicationAction(request, env, decodeURIComponent(publicationMatch[1]), login);

      // Run the retention sweep now rather than waiting for the cron trigger.
      // Guarded exactly like every other write: a session, a POST, and a CSRF
      // token. Without those, anyone who found the URL could delete applicant
      // data on a schedule of their choosing.
      if (path === "/retention/run") {
        const guard = await guardPost(request, env, login);
        if (guard.error) return guard.error;
        const report = await runSweep(env);
        return retentionResult(request, report);
      }

      return errorPage({ login, token, code: 404, title: "Not found", message: "There is nothing at this address." });
    } catch (error) {
      // This only catches anything because every route above is `return await`.
      // A bare `return fn()` hands the promise back and leaves the try block
      // before it settles, so the rejection reaches the runtime uncaught and the
      // caller is shown a stack trace naming this file and a bucket key.
      //
      // The reason is logged; the reviewer gets none of it, for the same reason.
      console.error(JSON.stringify({ event: "review_error", path, reason: String(error?.message || error) }));
      return errorPage({
        login,
        token,
        code: 500,
        title: "Something went wrong",
        message: "The dashboard could not complete that request. Nothing was changed.",
      });
    }
  },
};

// ---- One application -------------------------------------------------------

/**
 * The review page.
 *
 * It shows two states that are deliberately kept apart: the application's status,
 * which is a decision about the application, and the associate record's
 * publication state, which is a decision about the website. Both are needed, and
 * neither is derived from the other.
 *
 * The record's live state is read from the repository, because that file is what
 * the site is built from and R2's copy of it is only a record of what this
 * dashboard last did. If the repository cannot be read the page still renders,
 * from the R2 state, with a warning — a broken page would be a worse answer
 * than an out-of-date one, as long as it says which it is.
 */
async function showApplication(env, id, { login, token, flash, flashCode }) {
  if (!validApplicationId(id)) return notAnApplication(login, id, token);

  const application = await readApplication(env, id);
  if (!application) return notAnApplication(login, id, token);

  const review = (await readReview(env, id)) || emptyReview(login.login);

  let record = emptyRecordState();
  if (review.associate_id) {
    // Fresh, not cached: this is the state a reviewer is about to act on, and a
    // record that was changed in the repository or by another reviewer in the
    // last few seconds has to be shown as it is now. Showing a stale record here
    // would offer a button for something that is no longer true.
    const path = associatePath(review.associate_id);
    const file = await readTextFile(env, path, { fresh: true });
    if (!file.ok) {
      record = { ...emptyRecordState(), unreadable: true, reason: file.reason };
    } else if (file.missing) {
      record = { ...emptyRecordState(), missing: true, path };
    } else {
      record = {
        ok: true,
        path,
        visibility: readYamlScalar(file.text, "visibility"),
        profileStatus: readYamlScalar(file.text, "profile_status"),
        photo: readYamlScalar(file.text, "photo"),
        publicationPermitted: readYamlScalar(file.text, "publication_permitted"),
      };
    }
  }

  return reviewPage(application, review, { login, flash, flashCode, record, token });
}

function emptyRecordState() {
  return { ok: false, missing: false, unreadable: false, visibility: null, profileStatus: null, photo: null, publicationPermitted: null, path: null, reason: null };
}

/**
 * Stream a CV or photograph to a signed-in reviewer.
 *
 * The object stays in the private bucket. This is not a redirect to a signed
 * URL and not a permanent link: the request is authenticated, the object is
 * read server-side, and the response is marked un-cacheable, so a URL that
 * leaks into a browser history or a proxy log is useless without a session.
 *
 * The kind is matched against the keys in the stored record rather than built
 * from the request, so a crafted kind cannot reach outside the application's own
 * cv/ or photo/ folder.
 */
async function serveFile(env, id, url, login) {
  if (!validApplicationId(id)) return new Response("Not found", plain(404));

  const application = await readApplication(env, id);
  if (!application) return new Response("Not found", plain(404));

  const kind = url.searchParams.get("kind");
  if (kind !== "cv" && kind !== "photo") return new Response("Not found", plain(404));

  const file = application.files?.[kind];
  // The key is the one the submissions Worker wrote, not one built here.
  if (!file?.key || !String(file.key).startsWith(`applications/${id}/${kind}/`)) {
    return new Response("Not found", plain(404));
  }

  const object = await env.APPLICATIONS.get(file.key);
  if (!object) return new Response("Not found", plain(404));

  const inline = url.searchParams.get("disposition") === "inline";
  const headers = {
    "content-type": file.contentType || "application/octet-stream",
    "content-length": String(object.size),
    // Never cached, and never a URL another system can fetch.
    "cache-control": "no-store, private",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
  };
  // The file name is generated, so it is safe to use, and it says nothing about
  // the applicant. A photograph is offered inline so it can be looked at; a CV
  // is always a download, since rendering one in the browser is not useful.
  headers["content-disposition"] =
    `${inline && kind === "photo" ? "inline" : "attachment"}; filename="${basename(file.key)}"`;

  console.log(JSON.stringify({ event: "file_served", id, kind, reviewer: login.login }));

  return new Response(object.body, { status: 200, headers });
}

function basename(key) {
  return key.split("/").pop() || "file";
}

// ---- Actions ---------------------------------------------------------------

/**
 * Check that a request is a form post from this dashboard.
 *
 * The session cookie is `SameSite=Strict` and the dashboard is not framed, so
 * there are two layers already. The token is the third: it is the one that would
 * still hold if a cookie attribute were ever changed, which is worth having on
 * routes that write to a public repository.
 *
 * Returns `{ form }`, or `{ error }` holding the response to send instead. Every
 * action below starts here and cannot skip it.
 */
async function guardPost(request, env, login) {
  if (request.method !== "POST") return { error: methodNotAllowed() };

  const form = await readForm(request);
  const submitted = form.get("csrf");
  if (!(await verifyCsrf(env, login.login, submitted))) {
    return {
      error: errorPage({
        login,
        token: await csrfToken(env, login.login),
        code: 403,
        title: "Request not accepted",
        message: "This form could not be verified. Reload the page and try again.",
      }),
    };
  }
  return { form };
}

/** Approve an application and create its Associate record. */
async function approveAction(request, env, id, login) {
  const guard = await guardPost(request, env, login);
  if (guard.error) return guard.error;
  if (!validApplicationId(id)) return notAnApplication(login, id, await csrfToken(env, login.login));

  const result = await approveAndCreate(env, {
    id,
    reviewer: login.login,
    note: String(guard.form.get("note") || "").trim(),
  });

  // The status code is the outcome, not the navigation: a refusal is a 4xx and
  // an idempotent repeat is a 200, so a caller can tell them apart.
  return actionResult(request, id, result);
}

/** Publish or unpublish the profile, after re-checking consent from R2. */
async function publicationAction(request, env, id, login) {
  const guard = await guardPost(request, env, login);
  if (guard.error) return guard.error;
  if (!validApplicationId(id)) return notAnApplication(login, id, await csrfToken(env, login.login));

  const action = String(guard.form.get("action") || "");
  const result = await setPublication(env, { id, action, reviewer: login.login });

  // A successful change is recorded in the review state, because the audit trail
  // has to say who published someone and when. A refusal is not recorded as a
  // change: nothing changed.
  if (result.outcome === "written") {
    const application = await readApplication(env, id);
    if (application) {
      await saveReview(
        env,
        id,
        application,
        {
          associate_visibility: result.visibility,
          ...(result.visibility === "public"
            ? { associate_published_at: new Date().toISOString(), associate_published_by: login.login }
            : {}),
          historyAction: `publication:${result.visibility}`,
          historyNote: result.message,
        },
        login.login
      );
    }
    console.log(JSON.stringify({ event: "publication_changed", id, visibility: result.visibility, reviewer: login.login }));
  } else if (result.outcome === "refused") {
    console.log(JSON.stringify({ event: "publication_refused", id, code: result.code, reviewer: login.login }));
  }

  return actionResult(request, id, result);
}

/** Publish the applicant's photograph into the site. */
async function photographAction(request, env, id, login) {
  const guard = await guardPost(request, env, login);
  if (guard.error) return guard.error;
  if (!validApplicationId(id)) return notAnApplication(login, id, await csrfToken(env, login.login));

  const result = await publishPhotograph(env, { id, reviewer: login.login });

  if (result.outcome === "written") {
    const application = await readApplication(env, id);
    if (application) {
      await saveReview(
        env,
        id,
        application,
        { associate_photo_at: new Date().toISOString(), historyAction: "photograph_published", historyNote: result.message },
        login.login
      );
    }
  }

  return actionResult(request, id, result);
}

/**
 * Report an action's outcome.
 *
 * A browser — which is what the forms are — is redirected back to the
 * application with the message in the page, because a reviewer does not want to
 * read JSON. Anything asking for JSON gets the outcome and the real status code.
 *
 * The distinction is made on what the caller asked for, never on how the action
 * went, so a refusal cannot be reported as a success by accident: both paths
 * carry the same `message` and the same `code`, and only the framing differs.
 */
function actionResult(request, id, result) {
  const status = result.httpStatus || (result.outcome === "refused" ? 409 : 200);

  if (acceptsHtml(request)) {
    const suffix = result.code ? `&code=${encodeURIComponent(result.code)}` : "";
    return redirect(
      `/application/${encodeURIComponent(id)}?flash=${encodeURIComponent(result.message)}${suffix}`
    );
  }

  return new Response(
    JSON.stringify({
      outcome: result.outcome,
      code: result.code || null,
      message: result.message,
      associate_id: result.associateId || null,
      visibility: result.visibility || null,
      photo: result.photo || null,
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, private",
        "x-robots-tag": "noindex, nofollow",
      },
    }
  );
}

/**
 * Move an application to a new status.
 *
 * `approved` is not offered here. It is what the Approve & Create action sets,
 * together with the record it creates, so that "approved" and "has an Associate"
 * are the same event and cannot drift apart. Accepting it here would let the
 * status be set with no record behind it.
 */
async function changeStatus(request, env, id, login) {
  const guard = await guardPost(request, env, login);
  if (guard.error) return guard.error;
  if (!validApplicationId(id)) return notAnApplication(login, id, await csrfToken(env, login.login));

  const application = await readApplication(env, id);
  if (!application) return notAnApplication(login, id, await csrfToken(env, login.login));

  const status = String(guard.form.get("status") || "");
  if (!STATUSES.includes(status)) {
    return statusResult(request, id, { outcome: "refused", code: "unknown-status", message: "That status is not one of the review states." }, 400);
  }
  if (status === "approved") {
    return statusResult(request, id, {
      outcome: "refused",
      code: "approved-elsewhere",
      message: "Approved is set by Approve & Create Associate, which also creates the record. Use that action.",
    }, 409);
  }

  const note = String(guard.form.get("note") || "").trim();

  // A withdrawal is the applicant ending the process, and the policy deletes
  // those after thirty days. Deleting on a decision nobody wrote down is not
  // defensible, so the reason is required rather than optional — it is also the
  // only thing that distinguishes a withdrawal from a rejection.
  if (status === "withdrawn" && !note) {
    return statusResult(request, id, {
      outcome: "refused",
      code: "reason-required",
      message: "A withdrawal needs a short reason. It is kept with the review history and is what the retention sweep reads.",
    }, 400);
  }

  // A hold needs a date and a reason together; either alone is not a hold, so a
  // half-filled form cannot quietly keep an application past its period.
  const holdUntil = String(guard.form.get("retain_until") || "").trim();
  const holdReason = String(guard.form.get("retain_reason") || "").trim();
  const changes = {
    status,
    historyAction: `status:${status}`,
    historyNote: note || null,
  };
  if (holdUntil && holdReason) {
    changes.retention_hold_until = holdUntil;
    changes.retention_hold_reason = holdReason;
  } else if (holdReason || holdUntil) {
    return statusResult(request, id, {
      outcome: "refused",
      code: "hold-incomplete",
      message: "Holding an application needs both a date and a reason. Neither was changed.",
    }, 400);
  } else {
    // Submitting the form with the hold fields cleared releases the hold, which
    // is how a hold is lifted without a separate route.
    changes.retention_hold_until = null;
    changes.retention_hold_reason = null;
  }

  // The note goes into the audit history for the states where the reason
  // matters, so the next reviewer can see why without opening anything else.
  await saveReview(env, id, application, changes, login.login);

  console.log(JSON.stringify({
    event: "status_changed",
    id,
    status,
    reviewer: login.login,
    ...(changes.retention_hold_until ? { heldUntil: changes.retention_hold_until } : {}),
  }));

  return statusResult(request, id, {
    outcome: "written",
    message: changes.retention_hold_until
      ? `Status set to ${status}, with deletion held until ${changes.retention_hold_until}.`
      : `Status set to ${status}.`,
  }, 200);
}

/** Add an internal note. Notes never leave the private bucket. */
async function addNote(request, env, id, login) {
  const guard = await guardPost(request, env, login);
  if (guard.error) return guard.error;
  if (!validApplicationId(id)) return notAnApplication(login, id, await csrfToken(env, login.login));

  const application = await readApplication(env, id);
  if (!application) return notAnApplication(login, id, await csrfToken(env, login.login));

  const note = String(guard.form.get("note") || "");
  if (!note.trim()) {
    return statusResult(request, id, { outcome: "refused", code: "empty-note", message: "The note was empty." }, 400);
  }

  const current = (await readReview(env, id)) || emptyReview(login.login);
  const withNewNote = withNote(current, note, login.login);

  // The application is passed so consent is re-copied from the record; the note
  // itself is the only thing being added.
  await saveReview(
    env,
    id,
    application,
    { ...withNewNote, status: current.status, historyAction: "note" },
    login.login
  );

  console.log(JSON.stringify({ event: "note_added", id, reviewer: login.login }));

  return statusResult(request, id, { outcome: "written", message: "Note saved." }, 200);
}

/**
 * Report a sweep the reviewer asked for.
 *
 * Says plainly what was deleted and, separately, what could not be. A reviewer
 * who has just run this needs to know whether anything is still outstanding, and
 * a summary that quietly omitted the failures would leave them believing an
 * application had been removed when it had not.
 */
function retentionResult(request, report) {
  const failed = report.failures || [];
  const message = failed.length
    ? `Swept ${report.scanned} application${report.scanned === 1 ? "" : "s"}: ${report.deleted} deleted, ${report.uploadsDiscarded} upload set${report.uploadsDiscarded === 1 ? "" : "s"} removed. ${failed.length} could not be completed and are listed on the Applications page.`
    : `Swept ${report.scanned} application${report.scanned === 1 ? "" : "s"}: ${report.deleted} deleted, ${report.uploadsDiscarded} upload set${report.uploadsDiscarded === 1 ? "" : "s"} removed, ${report.needsReview} awaiting a decision. No failures.`;

  return actionResult(request, null, { outcome: failed.length ? "partial" : "written", message, httpStatus: 200 });
}

/** A status or note result, reported the same way as any other action. */
function statusResult(request, id, result, status) {
  return actionResult(request, id, { ...result, httpStatus: status });
}

// ---- Plumbing --------------------------------------------------------------

async function readForm(request) {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

function notAnApplication(login, id, token) {
  return errorPage({
    login,
    token,
    code: 404,
    title: "No such application",
    message: `There is no application with the id ${id}. It may never have arrived, or the record could not be read.`,
  });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

/**
 * Hand back a session cookie for a named account, for the test suite. The
 * allowlist is enforced here as well as in identify(), so a test asking for an
 * account that is not allowed gets nothing — the same answer a real sign-in
 * from that account would get.
 */
async function mintTestSession(request, env, expired) {
  const login = (new URL(request.url).searchParams.get("login") || "").trim();
  if (!login) return new Response("login required", plain(400));

  const session = expired
    ? await testExpiredSession(login, env)
    : await testSession(login, env);
  if (!session) return new Response("not allowed", plain(403));

  return new Response(JSON.stringify({ cookie: `${SESSION_COOKIE}=${session}` }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function methodNotAllowed() {
  return new Response("Method not allowed", plain(405));
}

/**
 * A plain-text response.
 *
 * The whole `init` object is built here, status included. Returning only the
 * headers and passing them as the init argument would drop the status, and a
 * refusal would answer 200 with a body that says "Not found".
 */
function plain(status) {
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, private",
      "x-robots-tag": "noindex, nofollow",
    },
  };
}

function acceptsHtml(request) {
  return String(request.headers.get("accept") || "").includes("text/html");
}

/**
 * The dashboard's own stylesheet, inlined.
 *
 * Kept in the Worker rather than served from the public site for the same
 * reason the pages are: nothing about the review interface belongs in a
 * directory a visitor can list. It is a separate stylesheet from the site's, so
 * adding to one cannot restyle the other.
 */
function stylesheet() {
  return new Response(STYLES, {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store, private",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

const STYLES = `
:root {
  --rv-ink: #14201d;
  --rv-muted: #5b6b66;
  --rv-line: #dcded9;
  --rv-paper: #ffffff;
  --rv-wash: #f4f4f1;
  --rv-forest: #173a35;
  --rv-terracotta: #b85c45;
  --rv-amber: #8a6a12;
  --rv-radius: 6px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Source Sans Pro", "Segoe UI", system-ui, -apple-system, sans-serif;
  color: var(--rv-ink);
  background: var(--rv-wash);
  line-height: 1.55;
}
code, pre { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
a { color: var(--rv-forest); }

.rv-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.85rem 1.5rem; background: var(--rv-forest); color: #f8f6f1;
}
.rv-bar-brand { font-size: 0.85rem; letter-spacing: 0.06em; text-transform: uppercase; }
.rv-account { display: flex; align-items: center; gap: 0.75rem; font-size: 0.9rem; }
.rv-account-name { color: #f8f6f1; }
.rv-account form { margin: 0; }

.rv-main-wrap { max-width: 1180px; margin: 0 auto; padding: 1.75rem 1.5rem 4rem; }

.rv-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; margin-bottom: 1.25rem; }
.rv-title { margin: 0.15rem 0 0.35rem; font-size: 1.75rem; line-height: 1.2; }
.rv-subtitle { margin: 0; color: var(--rv-muted); font-size: 0.95rem; }
.rv-subtitle-small { font-size: 0.82rem; }
.rv-breadcrumb { margin: 0; font-size: 0.85rem; }
.rv-flash { margin: 0 0 1.25rem; padding: 0.7rem 0.95rem; background: #eef4f1; border: 1px solid #cfe0d8; border-left: 4px solid var(--rv-forest); border-radius: var(--rv-radius); font-size: 0.92rem; }
.rv-flash-error { background: #fbf3f2; border-color: #e7c2bd; border-left-color: var(--rv-terracotta); }

.rv-tabs { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1.25rem; }
.rv-tab { padding: 0.4rem 0.8rem; border: 1px solid var(--rv-line); border-radius: 999px; background: var(--rv-paper); color: var(--rv-muted); text-decoration: none; font-size: 0.85rem; }
.rv-tab:hover { border-color: #b9c4bf; color: var(--rv-ink); }
.rv-tab.is-active { background: var(--rv-forest); border-color: var(--rv-forest); color: #f8f6f1; }
.rv-tab-count { opacity: 0.7; font-size: 0.8em; }

.rv-list { display: grid; gap: 0.6rem; }
.rv-row-card { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.95rem 1.15rem; background: var(--rv-paper); border: 1px solid var(--rv-line); border-radius: var(--rv-radius); text-decoration: none; color: inherit; }
.rv-row-card:hover { border-color: #a9b6b0; }
.rv-row-main { display: grid; gap: 0.15rem; }
.rv-name { font-weight: 600; }
.rv-row-meta { color: var(--rv-muted); font-size: 0.88rem; }
.rv-row-side { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
.rv-row-id { font-family: ui-monospace, Menlo, monospace; font-size: 0.76rem; color: var(--rv-muted); }
.rv-row-date { font-size: 0.8rem; color: var(--rv-muted); }

.rv-pill { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.75rem; letter-spacing: 0.03em; border: 1px solid var(--rv-line); }
.rv-status-submitted { background: #eef1f5; }
.rv-status-under-review { background: #e8eef6; border-color: #c3d3e8; }
.rv-status-changes-requested { background: #fbf3e2; border-color: #e6d3a4; }
.rv-status-approved { background: #e7f1ea; border-color: #bcd8c6; }
.rv-status-rejected { background: #fbeceb; border-color: #e7c2bd; }
.rv-status-archived { background: #eeeeec; }
.rv-pill-yes { background: #e7f1ea; border-color: #bcd8c6; }
.rv-pill-no { background: #fbeceb; border-color: #e7c2bd; color: #8c2f21; }
.rv-pill-unknown { background: #fbf3e2; border-color: #e6d3a4; color: var(--rv-amber); }
.rv-pill-linked { background: #eef1f5; }
.rv-pill-public { background: #e7f1ea; border-color: #bcd8c6; }
.rv-pill-private { background: #eeeeec; }

.rv-consent { margin: 0 0 1.5rem; padding: 1rem 1.15rem; border-radius: var(--rv-radius); border: 1px solid var(--rv-line); background: var(--rv-paper); }
.rv-consent-yes { border-left: 5px solid #2f7d4f; }
.rv-consent-no { border-left: 5px solid #a4382a; }
.rv-consent-unknown { border-left: 5px solid var(--rv-amber); }
.rv-consent-answer { margin: 0 0 0.3rem; font-size: 1.05rem; }
.rv-consent-note { margin: 0; font-size: 0.9rem; color: var(--rv-muted); }

.rv-body { display: grid; grid-template-columns: minmax(0, 1fr) 21rem; gap: 1.5rem; align-items: start; }
.rv-main { display: grid; gap: 1.25rem; }
.rv-section { background: var(--rv-paper); border: 1px solid var(--rv-line); border-radius: var(--rv-radius); padding: 1.25rem 1.4rem; }
.rv-section-title { margin: 0 0 0.9rem; font-size: 1.05rem; letter-spacing: 0.03em; text-transform: uppercase; color: var(--rv-muted); }
.rv-subsection-title { margin: 1.4rem 0 0.4rem; font-size: 0.95rem; }
.rv-note { margin: 0 0 0.7rem; font-size: 0.87rem; color: var(--rv-muted); }
.rv-note-strong { color: var(--rv-ink); }

.rv-grid { display: grid; gap: 0.85rem; margin: 0; }
.rv-row { display: grid; grid-template-columns: 12rem minmax(0, 1fr); gap: 1rem; }
.rv-row dt { font-size: 0.85rem; color: var(--rv-muted); }
.rv-row dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.rv-row dd p { margin: 0 0 0.5rem; }
.rv-empty { margin: 0; color: var(--rv-muted); font-style: italic; }
.rv-empty-block { padding: 1.5rem; background: var(--rv-paper); border: 1px dashed var(--rv-line); border-radius: var(--rv-radius); }
.rv-tags { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }
.rv-tag { padding: 0.15rem 0.55rem; background: var(--rv-wash); border: 1px solid var(--rv-line); border-radius: 999px; font-size: 0.8rem; }

.rv-files { display: grid; gap: 0.6rem; }
.rv-file { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; padding: 0.7rem 0.85rem; background: var(--rv-wash); border: 1px solid var(--rv-line); border-radius: var(--rv-radius); }
.rv-file-label { font-weight: 600; min-width: 6rem; }
.rv-file-note { font-size: 0.83rem; color: var(--rv-muted); }
.rv-file-actions { margin-left: auto; display: flex; gap: 0.4rem; }
.rv-file-missing { opacity: 0.7; }

.rv-side { display: grid; gap: 1rem; position: sticky; top: 1rem; }
.rv-panel { background: var(--rv-paper); border: 1px solid var(--rv-line); border-radius: var(--rv-radius); padding: 1.1rem 1.2rem; }
.rv-panel-locked { background: #fbf6f5; border-color: #e7c2bd; }
.rv-panel-good { background: #f4faf6; border-color: #bcd8c6; }
.rv-panel-title { margin: 0 0 0.6rem; font-size: 0.95rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--rv-muted); }

.rv-state { display: grid; gap: 0.3rem; margin: 0 0 0.9rem; }
.rv-state-row { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 0.5rem; font-size: 0.9rem; }
.rv-state-key { color: var(--rv-muted); }
.rv-state-value { font-weight: 600; }

.rv-form { display: grid; gap: 0.4rem; }
.rv-label { font-size: 0.85rem; color: var(--rv-muted); }
.rv-optional { font-style: italic; }
.rv-textarea, .rv-select, .rv-input {
  width: 100%; padding: 0.5rem 0.6rem; border: 1px solid var(--rv-line);
  border-radius: 4px; font: inherit; font-size: 0.9rem; background: var(--rv-paper); color: inherit;
}
.rv-textarea:focus, .rv-select:focus, .rv-input:focus { outline: 2px solid var(--rv-forest); outline-offset: 1px; }
.rv-subhead { margin: 1.2rem 0 0.35rem; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--rv-muted); }

.rv-btn { display: inline-block; padding: 0.45rem 0.9rem; border: 1px solid var(--rv-line); border-radius: 4px; background: var(--rv-paper); color: var(--rv-ink); font: inherit; font-size: 0.88rem; text-decoration: none; cursor: pointer; }
.rv-btn:hover { border-color: #a9b6b0; }
.rv-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
.rv-btn-primary { background: var(--rv-forest); border-color: var(--rv-forest); color: #f8f6f1; font-weight: 600; }
.rv-btn-primary:hover { background: #0f2a26; }
.rv-btn-small { padding: 0.25rem 0.6rem; font-size: 0.8rem; }
.rv-btn-login { padding: 0.7rem 1.4rem; font-size: 1rem; }
.rv-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.rv-actions form { margin: 0; }

.rv-history, .rv-notes { margin: 0 0 1rem; padding-left: 1.1rem; display: grid; gap: 0.5rem; }
.rv-history-item, .rv-note-item { display: grid; gap: 0.1rem; }
.rv-history-action { font-size: 0.85rem; font-weight: 600; }
.rv-history-meta, .rv-note-meta { font-size: 0.78rem; color: var(--rv-muted); }
.rv-history-note, .rv-note-text { font-size: 0.88rem; }

.rv-code { display: inline-block; padding: 0.1rem 0.4rem; background: var(--rv-wash); border: 1px solid var(--rv-line); border-radius: 4px; font-size: 0.82rem; }
.rv-warning { margin: 0 0 0.8rem; padding: 0.7rem 0.9rem; background: #fbf3e2; border: 1px solid #e6d3a4; border-radius: var(--rv-radius); font-size: 0.87rem; color: var(--rv-amber); }

.rv-login { max-width: 34rem; margin: 4rem auto; padding: 2rem; background: var(--rv-paper); border: 1px solid var(--rv-line); border-radius: var(--rv-radius); }

@media (max-width: 900px) {
  .rv-body { grid-template-columns: 1fr; }
  .rv-side { position: static; }
  .rv-row { grid-template-columns: 1fr; gap: 0.15rem; }
  .rv-state-row { grid-template-columns: 1fr; gap: 0; }
}
`;
