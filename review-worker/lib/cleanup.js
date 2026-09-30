/**
 * The scheduled cleanup sweep.
 *
 * Runs from a Cron Trigger, asks `lib/retention.js` what to do with each
 * application, and does it. The rules live in `retention.js`; this file is only
 * the part that touches the bucket.
 *
 * Three properties matter more than speed, and each one is a decision that a
 * faster implementation would get wrong:
 *
 * 1. **It only touches what it decided to touch.** Every key is built from an
 *    id that has already passed `validApplicationId`, and every key is under
 *    `applications/` or `review/`. An id that does not look like a generated
 *    token is refused before any listing happens, so a malformed record cannot
 *    turn a cleanup job into an arbitrary-prefix deleter.
 *
 * 2. **It never reports a deletion it cannot confirm.** R2's `delete` does not
 *    tell you whether the object was really gone. Every deletion is followed by
 *    a re-listing of the same prefix, and anything still there is a failure in
 *    the report — not a success.
 *
 * 3. **One bad application does not stop the sweep.** Each is handled in its own
 *    `try`, and a failure is collected and written to the report. A job that
 *    threw on the first error would leave every later application to rot.
 */

import { ACTIONS, decide } from "./retention.js";
import { listApplicationIds, readApplication, readReview, saveReview, validApplicationId, RETENTION_REPORT_KEY, consentOf } from "./store.js";

/** Every object belonging to one application, by key. */
async function listUnder(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.APPLICATIONS.list({ prefix, cursor });
    for (const object of page.objects || []) keys.push(object.key);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return keys;
}

/**
 * The keys the sweep is allowed to remove for one application, in the order it
 * should remove them.
 *
 * The metadata goes last, and that ordering is the point. Deleting the record
 * first and then failing on a CV would leave an upload in the bucket with
 * nothing describing it, and nothing for a person to find it by. Uploads first
 * means a failure leaves a whole application that the next sweep can retry.
 */
function keysFor(id, applicationKeys, reviewKeys, { keepRecord }) {
  const recordKey = `applications/${id}/application.json`;
  const stateKey = `review/${id}/state.json`;
  const keys = [...applicationKeys, ...reviewKeys];

  // Discarding uploads keeps the application and the decision that produced the
  // record; deleting the application removes both, because a review state
  // pointing at a record that is no longer in the bucket is misleading.
  const wanted = keepRecord ? keys.filter((key) => key !== recordKey && key !== stateKey) : keys;
  return wanted.sort((a, b) => Number(a === recordKey || a === stateKey) - Number(b === recordKey || b === stateKey));
}

/**
 * Delete keys and confirm they are gone.
 *
 * Stops at the first key that refuses. Because `keysFor` puts the metadata
 * last, a refusal part-way through leaves the application record in place, so
 * the next sweep sees a whole application again rather than a stray upload that
 * nothing points at.
 *
 * Returns the keys that survived, which is the honest result: an empty array
 * means verified gone. A failure to delete is reported per key so the report
 * says which object is still there, not merely that something went wrong.
 */
async function deleteAndVerify(env, keys) {
  const remaining = [];
  const errors = [];
  let aborted = false;

  for (const key of keys) {
    if (aborted) break;
    try {
      await env.APPLICATIONS.delete(key);
    } catch (error) {
      errors.push({ key, error: String(error?.message || error) });
      aborted = true;
    }
  }

  if (aborted) {
    // Stopping early means the remaining keys were deliberately not attempted.
    // They are reported as still present rather than silently left, so the
    // report is a complete description of the bucket's state.
    const attempted = new Set(keys);
    const untouched = keys.filter((key) => !errors.some((e) => e.key === key) && !remaining.includes(key));
    for (const prefix of [...new Set(untouched.map((key) => key.split("/").slice(0, 2).join("/") + "/"))]) {
      try {
        const stillThere = await listUnder(env, prefix);
        remaining.push(...stillThere.filter((key) => attempted.has(key)));
      } catch {
        // A verification that cannot run is not a verification.
      }
    }
    return { remaining, errors };
  }

  // The only way to know an object is gone is to look for it. `head` would be
  // one call per key; a single re-listing of the parent prefixes answers the
  // same question for all of them.
  const wanted = new Set(keys);
  for (const prefix of [...new Set(keys.map((key) => key.split("/").slice(0, 2).join("/") + "/"))]) {
    try {
      const stillThere = await listUnder(env, prefix);
      remaining.push(...stillThere.filter((key) => wanted.has(key)));
    } catch (error) {
      // A verification that cannot run is not a verification. Treating it as
      // "deleted" is exactly the false success this function exists to prevent.
      errors.push({ key: prefix, error: `could not verify: ${String(error?.message || error)}` });
    }
  }

  return { remaining, errors };
}

/**
 * Run one sweep.
 *
 * @param {object} env
 * @param {object} [options]
 * @param {string} [options.now]  ISO timestamp; pinned by the tests.
 * @param {boolean} [options.dryRun] Decide and report, but delete nothing.
 * @returns {Promise<object>} The report, which is also written to the bucket.
 */
export async function runSweep(env, { now = new Date().toISOString(), dryRun = false } = {}) {
  const report = {
    at: now,
    dryRun,
    scanned: 0,
    deleted: 0,
    uploadsDiscarded: 0,
    kept: 0,
    needsReview: 0,
    failures: [],
    decisions: [],
  };

  let ids;
  try {
    ids = await listApplicationIds(env);
  } catch (error) {
    // Without a listing there is nothing safe to do. Say so and stop, rather
    // than treating an empty list as "nothing to clean".
    report.failures.push({ id: null, stage: "list", error: String(error?.message || error) });
    return writeReport(env, report);
  }

  for (const id of ids) {
    // A key that does not look like an id we created is not ours to delete.
    if (!validApplicationId(id)) {
      report.failures.push({ id, stage: "validate", error: "the key is not a valid application id, so it was left alone" });
      continue;
    }

    report.scanned += 1;

    try {
      const [application, review] = await Promise.all([readApplication(env, id), readReview(env, id)]);
      const decision = decide({ application, review, now, consent: consentOf(application) });

      report.decisions.push({ id, action: decision.action, reason: decision.reason });

      if (decision.action === ACTIONS.KEEP) {
        report.kept += 1;
        continue;
      }

      if (decision.action === ACTIONS.REVIEW) {
        report.needsReview += 1;
        continue;
      }

      const keepRecord = decision.action === ACTIONS.DISCARD_UPLOADS;
      if (dryRun) continue;

      const applicationKeys = await listUnder(env, `applications/${id}/`);
      const reviewKeys = await listUnder(env, `review/${id}/`);
      const keys = keysFor(id, applicationKeys, reviewKeys, { keepRecord });

      if (!keys.length) {
        // Already gone. Idempotent: a second run finds nothing to do and says
        // so, rather than reporting a deletion that did not happen.
        report.kept += 1;
        continue;
      }

      const { remaining, errors } = await deleteAndVerify(env, keys);

      if (remaining.length || errors.length) {
        report.failures.push({
          id,
          stage: decision.action,
          error: errors.map((e) => e.error).join("; ") || null,
          stillPresent: remaining,
        });
        continue;
      }

      if (keepRecord) {
        // Stamped so a second sweep does not report the same work again, and so
        // the application page can say the uploads are gone.
        await saveReview(env, id, application, { uploads_discarded_at: now, historyAction: "uploads_discarded" }, "retention-sweep");
        report.uploadsDiscarded += 1;
      } else {
        report.deleted += 1;
      }
    } catch (error) {
      // One application failing is recorded and the sweep carries on.
      report.failures.push({ id, stage: "process", error: String(error?.message || error) });
    }
  }

  return writeReport(env, report);
}

/**
 * Write the report so an administrator can see what the sweep did, including
 * what it failed to do.
 *
 * A failure to write the report is itself reported to the log, because the log
 * is the only place left.
 */
async function writeReport(env, report) {
  try {
    await env.APPLICATIONS.put(RETENTION_REPORT_KEY, JSON.stringify(report, null, 2), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { kind: "retention-report" },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "retention_report_write_failed", error: String(error?.message || error) }));
  }
  return report;
}
