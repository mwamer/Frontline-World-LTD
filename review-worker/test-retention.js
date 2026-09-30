#!/usr/bin/env node
/**
 * Retention tests.
 *
 * The retention clock is the thing being tested, and it cannot be tested through
 * the dashboard: a rejected application 400 days into its period cannot be
 * created by clicking buttons, because the reviewer who made that decision is
 * long gone. So these tests drive `lib/retention.js` and `lib/cleanup.js`
 * directly against an in-memory R2, with the clock pinned.
 *
 * The R2 here is a fake, but it is a faithful one: `list` honours `prefix`,
 * `cursor` and `delimiter`, `delete` removes a key and nothing else, and it can
 * be told to fail on a given key so the failure path is exercised rather than
 * assumed. Nothing here touches the real bucket or the real repository.
 *
 *   node test-retention.js
 */

import { decide, ACTIONS, RETENTION_DAYS, addDays, daysSince, decisionAt, holdInForce, discardableUploads } from "./lib/retention.js";
import { runSweep } from "./lib/cleanup.js";

let pass = 0;
let fail = 0;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const head = (s) => console.log(`\n\x1b[1m=== ${s} ===\x1b[0m`);

function ok(label) { pass++; console.log(`  ${green("PASS")}  ${label}`); }
function bad(label, detail) { fail++; console.log(`  ${red("FAIL")}  ${label}`); if (detail) console.log(`          ${detail}`); }
function check(label, actual, expected) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  a === e ? ok(label) : bad(label, `got ${a}, expected ${e}`);
}
function isTrue(label, value, detail) { value ? ok(label) : bad(label, detail); }

// ---- An in-memory R2 --------------------------------------------------------

function fakeR2() {
  const store = new Map();
  const failures = { delete: new Set(), put: new Set(), list: new Set() };

  const prefixOf = (options) => (typeof options === "string" ? options : options?.prefix) || "";

  return {
    store,
    failures,
    async get(key) {
      const key_ = typeof key === "string" ? key : key.key;
      if (!store.has(key_)) return null;
      const value = store.get(key_);
      return { key: key_, size: value.length, text: async () => value };
    },
    async put(key, value) {
      if (failures.put.has(key)) throw new Error(`put refused for ${key}`);
      store.set(key, typeof value === "string" ? value : String(value));
    },
    async delete(key) {
      if (failures.delete.has(key)) throw new Error(`delete refused for ${key}`);
      store.delete(key);
    },
    async list(options = {}) {
      if (failures.list.has(prefixOf(options))) throw new Error(`list refused for ${prefixOf(options)}`);
      const prefix = prefixOf(options);
      const delimiter = typeof options === "object" ? options.delimiter : undefined;
      const all = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();

      if (delimiter) {
        // R2 rolls the segment after the delimiter up into a common prefix, so
        // one listing covers a whole folder regardless of what is inside it.
        const prefixes = new Set();
        const objects = [];
        for (const key of all) {
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf(delimiter);
          if (slash === -1) objects.push({ key });
          else prefixes.add(prefix + rest.slice(0, slash + 1));
        }
        return { objects, delimitedPrefixes: [...prefixes].sort(), truncated: false, cursor: undefined };
      }
      return { objects: all.map((key) => ({ key })), delimitedPrefixes: [], truncated: false, cursor: undefined };
    },
  };
}

/** A bucket holding one application, its uploads and a review state. */
async function seed(env, { id, status, decidedAt, consent, associate = {}, extra = {} }) {
  const application = {
    id,
    received_at: decidedAt || "2024-01-01T00:00:00.000Z",
    status: "submitted",
    consent: { public_profile: consent ? "yes" : "no", publication_permitted: consent, recorded_at: "2024-01-01T00:00:00.000Z" },
    fields: { name: `Applicant ${id.slice(-4)}`, email: `applicant-${id.slice(-4)}@example.com` },
    files: {
      cv: { key: `applications/${id}/cv/abc123.pdf`, size: 9, contentType: "application/pdf" },
      photo: { key: `applications/${id}/photo/def456.png`, size: 70, contentType: "image/png" },
    },
  };
  await env.put(`applications/${id}/application.json`, JSON.stringify(application));
  await env.put(`applications/${id}/cv/abc123.pdf`, "%PDF-1.4\n");
  await env.put(`applications/${id}/photo/def456.png`, "\x89PNG\r\n\x1a\n");

  const stamp = { rejected: "rejected_at", withdrawn: "withdrawn_at", approved: "approved_at" }[status];
  const review = {
    status,
    publication_permitted: consent,
    associate_id: null,
    ...(stamp ? { [stamp]: decidedAt } : {}),
    ...associate,
    notes: [],
    history: [],
    created_at: decidedAt || "2024-01-01T00:00:00.000Z",
    updated_at: decidedAt || "2024-01-01T00:00:00.000Z",
    ...extra,
  };
  await env.put(`review/${id}/state.json`, JSON.stringify(review));
  return { application, review };
}

const id = (n) => `app-20240101-${String(n).repeat(12).slice(0, 12)}`;
const NOW = "2026-06-01T00:00:00.000Z";

// ---- 1. The policy, period by period ----------------------------------------

head("Retention periods");

check("rejected is kept for 365 days", RETENTION_DAYS.rejected, 365);
check("withdrawn is kept for 30 days", RETENTION_DAYS.withdrawn, 30);
check("approved is reviewed after 730 days", RETENTION_DAYS.approvedReviewAfter, 730);

isTrue("addDays is calendar arithmetic", addDays("2026-01-01T00:00:00.000Z", 365) === "2027-01-01T00:00:00.000Z",
  `got ${addDays("2026-01-01T00:00:00.000Z", 365)}`);
check("daysSince rounds down, so a period never ends early",
  daysSince("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), -1);

// ---- 2. Every status, decided ------------------------------------------------

head("Decisions, per status");

{
  const d = decide({ application: {}, review: { status: "rejected", rejected_at: addDays(NOW, -400) }, now: NOW, consent: false });
  check("rejected 400 days ago is deleted", d.action, ACTIONS.DELETE);
  isTrue("the reason says how far past the period it is", /400 days ago, past the 365-day/.test(d.reason), d.reason);
}
{
  const d = decide({ application: {}, review: { status: "rejected", rejected_at: addDays(NOW, -364) }, now: NOW, consent: false });
  check("rejected 364 days ago is kept", d.action, ACTIONS.KEEP);
  isTrue("the reason names the period", /inside the 365-day/.test(d.reason), d.reason);
}
{
  const d = decide({ application: {}, review: { status: "rejected", rejected_at: addDays(NOW, -365) }, now: NOW, consent: false });
  check("rejected on the last day of the period is deleted, not before", d.action, ACTIONS.DELETE);
}
{
  const d = decide({ application: {}, review: { status: "withdrawn", withdrawn_at: addDays(NOW, -31) }, now: NOW, consent: false });
  check("withdrawn 31 days ago is deleted", d.action, ACTIONS.DELETE);
}
{
  const d = decide({ application: {}, review: { status: "withdrawn", withdrawn_at: addDays(NOW, -29) }, now: NOW, consent: false });
  check("withdrawn 29 days ago is kept", d.action, ACTIONS.KEEP);
}
{
  const d = decide({ application: {}, review: { status: "approved", approved_at: addDays(NOW, -800), associate_id: "a-b" }, now: NOW, consent: false });
  check("an approved application is never deleted automatically", d.action, ACTIONS.DISCARD_UPLOADS);
  isTrue("and the reason says the application itself is kept", /the application itself is kept/.test(d.reason), d.reason);
}
{
  const d = decide({ application: {}, review: { status: "approved", approved_at: addDays(NOW, -800), associate_id: "a-b", associate_photo_at: addDays(NOW, -700) }, now: NOW, consent: true });
  check("approved 800 days ago with a published photograph discards both uploads", d.files, ["cv", "photo"]);
}
{
  const d = decide({ application: {}, review: { status: "approved", approved_at: addDays(NOW, -800), associate_id: "a-b" }, now: NOW, consent: true });
  check("an unpublished photograph is kept when consent was given", d.files, ["cv"]);
  isTrue("and the reason says why", /no longer needed: cv/.test(d.reason), d.reason);
}
{
  const d = decide({ application: {}, review: { status: "approved", approved_at: addDays(NOW, -100), associate_id: "a-b" }, now: NOW, consent: false });
  check("an approved application inside 24 months keeps its uploads", d.action, ACTIONS.KEEP);
}
{
  const d = decide({ application: {}, review: { status: "approved", approved_at: addDays(NOW, -700), associate_id: "a-b", associate_photo_at: addDays(NOW, -600) }, now: NOW, consent: true });
  check("an approved application inside 24 months is not flagged for review", d.action, ACTIONS.KEEP);
}
{
  const d = decide({ application: {}, review: { status: "under-review" }, now: NOW, consent: false });
  check("an application under review is kept", d.action, ACTIONS.KEEP);
}
{
  const d = decide({ application: {}, review: { status: "submitted" }, now: NOW, consent: false });
  check("an unreviewed application is kept", d.action, ACTIONS.KEEP);
}
{
  const d = decide({ application: {}, review: { status: "archived" }, now: NOW, consent: false });
  check("an archived application is kept", d.action, ACTIONS.KEEP);
}
{
  const d = decide({ application: {}, review: null, now: NOW, consent: false });
  check("an application with no review state is kept", d.action, ACTIONS.KEEP);
  isTrue("because nothing has been decided", /still open/.test(d.reason), d.reason);
}

// ---- 3. Holds ---------------------------------------------------------------

head("Documented holds");

{
  const d = decide({
    application: {}, now: NOW, consent: false,
    review: { status: "rejected", rejected_at: addDays(NOW, -400), retention_hold_until: addDays(NOW, 30).slice(0, 10), retention_hold_reason: "dispute with the applicant" },
  });
  check("a hold in force keeps an overdue application", d.action, ACTIONS.KEEP);
  isTrue("and says until when", /held until/.test(d.reason), d.reason);
}
{
  const d = decide({
    application: {}, now: NOW, consent: false,
    review: { status: "rejected", rejected_at: addDays(NOW, -400), retention_hold_until: addDays(NOW, -10).slice(0, 10), retention_hold_reason: "a hold that has passed" },
  });
  check("a hold that has expired no longer holds", d.action, ACTIONS.DELETE);
}
{
  const d = decide({
    application: {}, now: NOW, consent: false,
    review: { status: "rejected", rejected_at: addDays(NOW, -400), retention_hold_until: addDays(NOW, 30).slice(0, 10), retention_hold_reason: "" },
  });
  check("a hold date with no reason is not a hold", d.action, ACTIONS.DELETE);
}
check("holdInForce ignores a missing reason", holdInForce({ retention_hold_until: "2030-01-01" }, NOW), null);

// ---- 4. Records that predate the stamps -------------------------------------

head("Records written before the decision stamps existed");

check("the fallback reads a rejection from the history",
  decisionAt({ history: [{ to: "rejected", at: "2025-01-01T00:00:00.000Z" }] }, "rejected"),
  "2025-01-01T00:00:00.000Z");
check("the latest rejection wins, not the first",
  decisionAt({ history: [{ to: "rejected", at: "2024-01-01T00:00:00.000Z" }, { to: "rejected", at: "2025-06-01T00:00:00.000Z" }] }, "rejected"),
  "2025-06-01T00:00:00.000Z");
{
  const d = decide({ application: {}, review: { status: "rejected", history: [{ to: "rejected", at: addDays(NOW, -400) }] }, now: NOW, consent: false });
  check("an unstamped rejection is dated from its history and deleted", d.action, ACTIONS.DELETE);
}
{
  const d = decide({ application: {}, review: { status: "rejected" }, now: NOW, consent: false });
  check("a rejection with no date at all is kept, not guessed at", d.action, ACTIONS.KEEP);
  isTrue("and the reason says the clock cannot be read", /cannot be read/.test(d.reason), d.reason);
}

// ---- 5. Uploads -------------------------------------------------------------

head("Which uploads are discardable");

check("no record means no upload is discardable",
  discardableUploads({ associate_id: null }, false).files, []);
check("an already-discarded set is not discarded twice",
  discardableUploads({ associate_id: "a-b", uploads_discarded_at: "2026-01-01T00:00:00.000Z" }, false).files, []);
check("consent withheld means the photograph can never be published, so both go",
  discardableUploads({ associate_id: "a-b" }, false).files, ["cv", "photo"]);
check("consent given and photograph published means both go",
  discardableUploads({ associate_id: "a-b", associate_photo_at: "2026-01-01T00:00:00.000Z" }, true).files, ["cv", "photo"]);

// ---- 6. The sweep -----------------------------------------------------------

head("The sweep, against an in-memory bucket");

{
  const env = fakeR2();
  const APPLICATIONS = { get: env.get, put: env.put, delete: env.delete, list: env.list };

  // The six required scenarios, plus a bystander that must survive untouched.
  await seed(env, { id: id(1), status: "rejected", decidedAt: addDays(NOW, -400), consent: false });
  await seed(env, { id: id(2), status: "rejected", decidedAt: addDays(NOW, -100), consent: false });
  await seed(env, { id: id(3), status: "withdrawn", decidedAt: addDays(NOW, -45), consent: false });
  await seed(env, { id: id(4), status: "approved", decidedAt: addDays(NOW, -800), consent: false, associate: { associate_id: "old-associate" } });
  await seed(env, { id: id(5), status: "approved", decidedAt: addDays(NOW, -30), consent: true, associate: { associate_id: "new-associate" } });
  await seed(env, { id: id(6), status: "under-review", decidedAt: NOW, consent: true });

  // Things in the bucket that are none of the sweep's business.
  await env.put("media/press-photo.jpg", "not an application");
  await env.put("retention/last-run.json", "{}");

  const report = await runSweep({ APPLICATIONS }, { now: NOW });

  check("every application was scanned", report.scanned, 6);
  check("no sweep failure", report.failures.length, 0);

  check("the overdue rejection is gone, uploads and all",
    env.store.has(`applications/${id(1)}/application.json`) || env.store.has(`applications/${id(1)}/cv/abc123.pdf`), false);
  check("its review state is gone too", env.store.has(`review/${id(1)}/state.json`), false);
  check("the rejection inside its period is kept", env.store.has(`applications/${id(2)}/application.json`), true);
  check("the overdue withdrawal is gone", env.store.has(`applications/${id(3)}/application.json`), false);
  check("the old approved application is kept", env.store.has(`applications/${id(4)}/application.json`), true);
  check("its CV is removed", env.store.has(`applications/${id(4)}/cv/abc123.pdf`), false);
  check("its photograph is removed, because consent was withheld", env.store.has(`applications/${id(4)}/photo/def456.png`), false);
  check("the recent approved application is untouched", env.store.has(`applications/${id(5)}/application.json`), true);
  check("its CV is still there, inside the review period", env.store.has(`applications/${id(5)}/cv/abc123.pdf`), true);
  check("the application under review is untouched", env.store.has(`applications/${id(6)}/application.json`), true);

  check("an unrelated object is untouched", env.store.get("media/press-photo.jpg"), "not an application");
  check("the sweep reported two deletions", report.deleted, 2);
  check("the sweep reported one upload set removed", report.uploadsDiscarded, 1);

  isTrue("the discarded uploads are stamped, so a second sweep is quiet",
    JSON.parse(env.store.get(`review/${id(4)}/state.json`)).uploads_discarded_at === NOW);

  // Idempotency: running again must change nothing and claim nothing.
  const again = await runSweep({ APPLICATIONS }, { now: NOW });
  check("a second sweep deletes nothing more", again.deleted, 0);
  check("and discards nothing more", again.uploadsDiscarded, 0);
  check("and still reports no failure", again.failures.length, 0);
  check("and leaves the bystander alone", env.store.get("media/press-photo.jpg"), "not an application");
}

head("The sweep, when deletion fails");

{
  const env = fakeR2();
  const APPLICATIONS = { get: env.get, put: env.put, delete: env.delete, list: env.list };

  await seed(env, { id: id(1), status: "rejected", decidedAt: addDays(NOW, -400), consent: false });
  await seed(env, { id: id(2), status: "rejected", decidedAt: addDays(NOW, -400), consent: false });

  // The CV of the first application refuses to delete. Its record must survive,
  // and the sweep must say so rather than counting a deletion that did not happen.
  env.failures.delete.add(`applications/${id(1)}/cv/abc123.pdf`);

  const report = await runSweep({ APPLICATIONS }, { now: NOW });

  check("the failed application is reported", report.failures.length, 1);
  check("it is reported against the right application", report.failures[0].id, id(1));
  isTrue("the surviving object is named, not just the failure",
    (report.failures[0].stillPresent || []).includes(`applications/${id(1)}/cv/abc123.pdf`),
    JSON.stringify(report.failures[0]));
  check("it is not counted as deleted", report.deleted, 1);
  check("the application record survives, because the metadata is deleted last", env.store.has(`applications/${id(1)}/application.json`), true);
  check("and so does its review state, so it is not left half-decided", env.store.has(`review/${id(1)}/state.json`), true);
  check("the second application was still processed", env.store.has(`applications/${id(2)}/application.json`), false);

  // The next sweep must find the failed one again and finish the job.
  env.failures.delete.clear();
  const retry = await runSweep({ APPLICATIONS }, { now: NOW });
  check("a retry deletes the application the first sweep could not finish", retry.deleted, 1);
  check("and the record is then gone", env.store.has(`applications/${id(1)}/application.json`), false);
  check("with no failure left", retry.failures.length, 0);
}

head("The sweep, when an object survives deletion silently");

{
  // R2 can accept a delete and leave the object. The only defence is to look
  // afterwards, so this proves the verification is what catches it.
  const env = fakeR2();
  const APPLICATIONS = { get: env.get, put: env.put, list: env.list };
  APPLICATIONS.delete = async () => { /* accepts, does nothing */ };

  await seed(env, { id: id(1), status: "rejected", decidedAt: addDays(NOW, -400), consent: false });
  const report = await runSweep({ APPLICATIONS }, { now: NOW });

  check("a delete that does not delete is reported as a failure", report.failures.length, 1);
  isTrue("and the object is named as still present",
    (report.failures[0].stillPresent || []).length > 0, JSON.stringify(report.failures[0]));
  check("and nothing is counted as deleted", report.deleted, 0);
}

head("The sweep, when the bucket cannot be listed");

{
  const env = fakeR2();
  const APPLICATIONS = { get: env.get, put: env.put, delete: env.delete, list: env.list };
  await seed(env, { id: id(1), status: "rejected", decidedAt: addDays(NOW, -400), consent: false });
  env.failures.list.add("applications/");

  const report = await runSweep({ APPLICATIONS }, { now: NOW });
  check("a failed listing is reported", report.failures.length, 1);
  check("and nothing is deleted on the strength of an empty list", report.deleted, 0);
  check("the application is still there", env.store.has(`applications/${id(1)}/application.json`), true);
}

head("The sweep refuses keys that are not application ids");

{
  const env = fakeR2();
  const APPLICATIONS = { get: env.get, put: env.put, delete: env.delete, list: env.list };
  await env.put("applications/../../secrets/thing.json", "not an application id");
  await env.put("applications/app-20240101-aaaaaaaaaaaa/application.json", JSON.stringify({ id: "app-20240101-aaaaaaaaaaaa", fields: {}, consent: {} }));
  await env.put("review/app-20240101-aaaaaaaaaaaa/state.json", JSON.stringify({ status: "rejected", rejected_at: addDays(NOW, -400) }));
  await env.put("secrets/token.txt", "must survive");

  const report = await runSweep({ APPLICATIONS }, { now: NOW });
  isTrue("a malformed key is refused, not followed", (report.failures || []).some((f) => String(f.id).includes("..")),
    JSON.stringify(report.failures));
  check("the object under it is untouched", env.store.get("applications/../../secrets/thing.json"), "not an application id");
  check("an unrelated secret-like object is untouched", env.store.get("secrets/token.txt"), "must survive");
}

head("A dry run decides but deletes nothing");

{
  const env = fakeR2();
  const APPLICATIONS = { get: env.get, put: env.put, delete: env.delete, list: env.list };
  await seed(env, { id: id(1), status: "rejected", decidedAt: addDays(NOW, -400), consent: false });

  const report = await runSweep({ APPLICATIONS }, { now: NOW, dryRun: true });
  check("a dry run deletes nothing", report.deleted, 0);
  check("and says it was one", report.dryRun, true);
  check("but the decision is still recorded", report.decisions[0].action, ACTIONS.DELETE);
  check("and the application survives", env.store.has(`applications/${id(1)}/application.json`), true);
}

// ---- The decision clock is not restartable ---------------------------------

// The sweep writes `uploads_discarded_at` on every approved application it
// tidies. If that write moved `approved_at`, the clock would restart forever and
// the 24-month review would never come due, so this is worth pinning down.
console.log("\nThe decision clock is not restartable");
{
  // A distinct, increasing clock reading per write, so "the stamp did not move"
  // and "the stamp did move" are both real comparisons rather than two strings
  // that happen to be equal because they landed in the same millisecond.
  const at = (step) => addDays(NOW, step).replace("T00:00:00.000Z", `T0${step}:00:00.000Z`);

  const { saveReview, readReview } = await import("./lib/store.js");
  const env = fakeR2();
  const APPLICATIONS = { get: env.get, put: env.put, delete: env.delete, list: env.list };

  const id = "app-20240101-cccccccccccc";
  await env.put(`applications/${id}/application.json`, JSON.stringify({ id, consent: { photo: "yes" } }), "application");
  await saveReview({ APPLICATIONS }, id, {}, { status: "approved" }, "reviewer", { now: at(1) });

  const first = await readReview({ APPLICATIONS }, id);
  const firstStamp = first.approved_at;
  if (firstStamp) ok("approval is stamped"); else bad("approval is stamped");

  // The sweep's own housekeeping write, with the status left alone.
  await saveReview({ APPLICATIONS }, id, {}, { uploads_discarded_at: "2026-01-01T00:00:00.000Z", historyAction: "uploads_discarded" }, "retention-sweep", { now: at(99) });
  const afterSweep = await readReview({ APPLICATIONS }, id);
  if (afterSweep.approved_at === firstStamp) ok("the sweep's own write does not move the approval date");
  else bad("the sweep's own write does not move the approval date", `${firstStamp} -> ${afterSweep.approved_at}`);

  // A note, likewise.
  await saveReview({ APPLICATIONS }, id, {}, { note: "Just an internal note", historyAction: "note" }, "reviewer", { now: at(2) });
  const afterNote = await readReview({ APPLICATIONS }, id);
  if (afterNote.approved_at === firstStamp) ok("adding a note does not move the approval date");
  else bad("adding a note does not move the approval date", `${firstStamp} -> ${afterNote.approved_at}`);

  // A crafted POST that sets the status it already has must be a no-op for the
  // clock too, or the deadline is pushable by hand.
  await saveReview({ APPLICATIONS }, id, {}, { status: "approved" }, "reviewer", { now: at(3) });
  const afterRepeat = await readReview({ APPLICATIONS }, id);
  if (afterRepeat.approved_at === firstStamp) ok("re-submitting the same status does not move the date");
  else bad("re-submitting the same status does not move the date", `${firstStamp} -> ${afterRepeat.approved_at}`);

  // A real transition back and forward must re-stamp, because the period counts
  // from the final decision.
  await saveReview({ APPLICATIONS }, id, {}, { status: "awaiting_changes" }, "reviewer", { now: at(4) });
  await saveReview({ APPLICATIONS }, id, {}, { status: "approved" }, "reviewer", { now: at(5) });
  const afterReapproval = await readReview({ APPLICATIONS }, id);
  if (afterReapproval.approved_at > firstStamp) ok("re-approving after a reopen re-stamps the date");
  else bad("re-approving after a reopen re-stamps the date", `${firstStamp} -> ${afterReapproval.approved_at}`);

  // And the stamp survives a reopen, so a reopened application is not dated from
  // the superseded decision.
  const reopened = await readReview({ APPLICATIONS }, id);
  if (reopened.approved_at) ok("the stamp is present after a reopen");
  else bad("the stamp is present after a reopen");
}

// ---- Summary ----------------------------------------------------------------

console.log(`\nPassed: ${pass}   Failed: ${fail}`);
process.exit(fail ? 1 : 0);
