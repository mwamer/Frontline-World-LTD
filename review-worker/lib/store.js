/**
 * Reading applications out of R2, and writing review decisions back.
 *
 * The submissions Worker owns `applications/<id>/` and nothing here changes
 * that. Review state lives beside it under `review/<id>/state.json`, so a
 * decision and the application it decides on are in the same private bucket and
 * cannot drift apart: there is no second database to fall out of step.
 *
 * R2 is a key-value store, not a database. Everything here is a get, a put and
 * a list. That is enough for a handful of applications a week and avoids adding
 * a database to review a queue that size.
 */

/**
 * The statuses a review can be in. Order is the order they are offered in.
 *
 * `withdrawn` is the applicant ending the process rather than the organisation
 * declining it. It is a distinct status because it carries a different
 * retention period — see `lib/retention.js` — and folding it into `archived` or
 * `rejected` would silently apply the wrong one.
 */
export const STATUSES = [
  "submitted",
  "under-review",
  "changes-requested",
  "approved",
  "rejected",
  "withdrawn",
  "archived",
];

const STATUS_LABELS = {
  submitted: "Submitted",
  "under-review": "Under Review",
  "changes-requested": "Changes Requested",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  archived: "Archived",
};

/**
 * The statuses that end an application, and the field that records when.
 *
 * The retention clock cannot be derived from `updated_at`: a rejected
 * application that is reopened, annotated and closed again has a recent
 * `updated_at` and a much older rejection, and deleting on the recent date would
 * be either far too early or far too late. The decision gets its own timestamp,
 * stamped on the transition into the state, and re-stamped if the application
 * is rejected again after being reopened — because the policy counts from the
 * final decision, not the first.
 */
const DECISION_STAMP = {
  rejected: "rejected_at",
  withdrawn: "withdrawn_at",
  approved: "approved_at",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || "Unknown";
}

/**
 * A stored decision, with everything the reviewer needs on the page.
 *
 * `publication_permitted` is read from the application record and only ever
 * from there. It is copied in on creation and never accepted from a form, so
 * there is no input a reviewer could use to contradict an applicant's answer.
 *
 * The `associate_*` fields describe a record this dashboard created. They are
 * kept separate from `status` on purpose: an application can be Approved while
 * its associate is Private, and those are different decisions with different
 * people responsible for them. The application status answers "what did we
 * decide about this application"; the associate fields answer "what has been
 * done with the public record since".
 */
export function emptyReview(reviewer) {
  return {
    status: "submitted",
    // A record with no application_id predates the pipeline: there is no
    // application to read consent from, so the decision is explicitly null and
    // the reviewer is told to check the application by hand.
    publication_permitted: null,
    associate_id: null,
    associate_visibility: null,
    associate_created_at: null,
    associate_created_by: null,
    associate_published_at: null,
    associate_published_by: null,
    associate_photo_at: null,
    consent_fingerprint: null,
    // When each ending decision was made, and until when deletion is held back.
    // See `lib/retention.js` for how these are read.
    rejected_at: null,
    withdrawn_at: null,
    approved_at: null,
    retention_hold_until: null,
    retention_hold_reason: null,
    uploads_discarded_at: null,
    notes: [],
    history: [{ at: new Date().toISOString(), action: "submitted", reviewer: reviewer || "system" }],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** List every application id in the bucket, newest first. */
export async function listApplicationIds(env) {
  const ids = [];
  let cursor;

  do {
    // The delimiter makes R2 return the application folders as common prefixes
    // rather than every object inside them, so one listing call covers a
    // thousand applications at the same cost as one with three objects in it.
    const page = await env.APPLICATIONS.list({ prefix: "applications/", cursor, delimiter: "/" });

    for (const prefix of page.delimitedPrefixes || []) {
      const id = prefix.replace(/^applications\//, "").replace(/\/$/, "");
      if (id) ids.push(id);
    }
    // A build of the R2 API that ignores the delimiter hands back the objects
    // instead, so those are read too rather than yielding an empty list.
    for (const object of page.objects || []) {
      const id = object.key.replace(/^applications\//, "").split("/")[0];
      if (id && !ids.includes(id)) ids.push(id);
    }

    cursor = page.truncated ? page.cursor : null;
  } while (cursor);

  return ids;
}

/**
 * The list the dashboard opens with.
 *
 * An application whose record cannot be read is still listed, with the id and a
 * marker, because an application a reviewer cannot see is worse than an
 * incomplete row: it looks like the application never arrived.
 */
export async function listApplications(env) {
  const ids = await listApplicationIds(env);
  const rows = [];

  for (const id of ids) {
    const application = await readApplication(env, id);
    const review = await readReview(env, id);

    rows.push({
      id,
      unreadable: !application,
      received_at: application?.received_at || null,
      name: application?.fields?.name || "",
      organisation: application?.fields?.organisation || "",
      title: application?.fields?.title || "",
      consent: application?.consent || null,
      files: application?.files || {},
      review,
      status: review?.status || "submitted",
    });
  }

  // Newest first. An unreadable record has no date, so it sorts last rather
  // than pretending to be recent.
  rows.sort((a, b) => {
    const left = a.received_at ? Date.parse(a.received_at) : 0;
    const right = b.received_at ? Date.parse(b.received_at) : 0;
    return right - left;
  });

  return rows;
}

/** One application record, or null when it is missing or unreadable. */
export async function readApplication(env, id) {
  if (!validApplicationId(id)) return null;
  const object = await env.APPLICATIONS.get(`applications/${id}/application.json`);
  if (!object) return null;
  try {
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

/** The stored review decision for an application, or null if there is none. */
export async function readReview(env, id) {
  if (!validApplicationId(id)) return null;
  const object = await env.APPLICATIONS.get(`review/${id}/state.json`);
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Record a decision.
 *
 * The application is read first and its consent copied in, so
 * `publication_permitted` on a stored review is always the applicant's own
 * answer as held in the application record. A caller cannot pass a different
 * value, because there is no parameter to pass one in.
 *
 * The decision timestamps are stamped here rather than by each caller. They are
 * what the retention clock reads, and a status that could be set without one
 * would leave the cleanup sweep with an application it cannot date — so the
 * invariant is enforced in the one function every status change goes through.
 */
export async function saveReview(env, id, application, changes, reviewer, options = {}) {
  const previous = (await readReview(env, id)) || emptyReview(reviewer);
  // `options.now` exists so the tests can pin the clock. The decision stamps are
  // compared against each other, and two writes in the same millisecond produce
  // identical strings, which makes every one of those assertions vacuous.
  const now = options.now || new Date().toISOString();
  const nextStatus = changes.status || previous.status;

  const next = {
    ...previous,
    ...changes,
    // Consent is never taken from the caller.
    publication_permitted: consentOf(application),
    // The application is the only place consent may come from.
    application_id: id,
    history: [
      ...(previous.history || []),
      {
        at: now,
        action: changes.historyAction || changes.status || "updated",
        from: previous.status,
        to: nextStatus,
        reviewer: reviewer || "unknown",
        note: changes.historyNote || null,
      },
    ],
    created_at: previous.created_at || now,
    updated_at: now,
  };

  // Stamping happens after the spread, so a caller cannot hand in its own value
  // and it survives a reopen: the stamp is only moved when the status is
  // actually entered, never when the application is annotated afterwards.
  //
  // Comparing against `previous.status`, not `nextStatus` alone, is what makes
  // that true. A note, a publication change, or the sweep's own
  // `uploads_discarded_at` write all call this with the status unchanged, and
  // those must not restart the clock. Without that comparison the sweep would
  // re-stamp `approved_at` on every run and the 24-month review would never
  // come due. It also means a crafted POST that sets the status it already has
  // is idempotent rather than a way to push the deadline out.
  const changed = nextStatus !== previous.status;
  for (const [status, field] of Object.entries(DECISION_STAMP)) {
    if (nextStatus === status && changed) next[field] = now;
    else if (next[field] === undefined) next[field] = previous[field] ?? null;
  }

  // `historyAction` and `historyNote` shape the audit entry, they are not
  // themselves part of the state.
  delete next.historyAction;
  delete next.historyNote;

  await env.APPLICATIONS.put(`review/${id}/state.json`, JSON.stringify(next, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { application_id: id, kind: "review-state" },
  });

  return next;
}

/**
 * The applicant's own answer to publication, and nothing else.
 *
 * `publication_permitted` was set by the submissions Worker at the moment of
 * submission and is stored in the application record. Reading it here — rather
 * than from a review form — is what makes consent a technical constraint
 * instead of a promise.
 */
export function consentOf(application) {
  if (!application || !application.consent) return null;
  if (typeof application.consent.publication_permitted === "boolean") {
    return application.consent.publication_permitted;
  }
  // The submitted answer, as a fallback for a record written before the flag
  // was added. Still the applicant's answer, still not a reviewer's.
  if (application.consent.public_profile === "yes") return true;
  if (application.consent.public_profile === "no") return false;
  return null;
}

/**
 * A digest of the consent facts, so a record can be traced to the answer it was
 * built from.
 *
 * The input is the four consent values that matter, canonicalised to a fixed key
 * order, and hashed with SHA-256. Comparing this later tells you whether the
 * application's consent block is the one the record was approved against — if it
 * is not, the publication route refuses rather than guessing which answer the
 * reviewer thought they were acting on.
 *
 * What this is not: it is a checksum, not a signature. Anyone who can change the
 * record can change its fingerprint too, so it detects a changed R2 record and a
 * careless edit; it does not make the record tamper-evident against someone with
 * repository write access. The check that actually enforces consent is the read
 * of the application in `lib/publication.js`, and this is corroboration.
 */
export async function consentFingerprint(application) {
  if (!application) return null;
  const consent = application.consent || {};
  const canonical = JSON.stringify({
    application_id: String(application.id || ""),
    public_profile: String(consent.public_profile ?? ""),
    publication_permitted: typeof consent.publication_permitted === "boolean" ? consent.publication_permitted : null,
    recorded_at: String(consent.recorded_at ?? ""),
  });

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Append an internal note, keeping the existing history intact. */
export function withNote(review, note, reviewer) {
  const trimmed = String(note || "").trim();
  if (!trimmed) return review;
  return {
    ...review,
    notes: [...(review.notes || []), { at: new Date().toISOString(), reviewer: reviewer || "unknown", text: trimmed }],
  };
}

/** An application id is a generated, date-ordered token. Nothing else. */
export function validApplicationId(id) {
  return typeof id === "string" && /^app-\d{8}-[a-f0-9]{12}$/.test(id);
}

/** Where the cleanup sweep writes what it did, so a person can read it. */
export const RETENTION_REPORT_KEY = "retention/last-run.json";

/**
 * The last cleanup sweep's report, or null when there has never been one.
 *
 * A missing report is not an error: the bucket has just never been swept, which
 * is true of a fresh install and after deleting the report by hand.
 */
export async function readRetentionReport(env) {
  const object = await env.APPLICATIONS.get(RETENTION_REPORT_KEY);
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // A truncated report must not hide the fact that a sweep has run. The
    // dashboard shows it as unreadable rather than as "no failures".
    return { unreadable: true, at: null, failures: [], kept: 0, deleted: 0 };
  }
}
