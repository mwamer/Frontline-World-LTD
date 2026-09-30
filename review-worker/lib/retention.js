/**
 * How long application data is kept, and when it may go.
 *
 * This module is deliberately pure: it reads two records and returns a
 * decision. It performs no I/O, calls no R2, and writes nothing. Every rule
 * below can therefore be tested directly, and the sweep in `lib/cleanup.js` is
 * reduced to "read, ask this, act".
 *
 * These are operational retention periods chosen for this organisation. They
 * are not a statement about what any law requires, and they are not advice.
 * Someone responsible for data protection should confirm them against the
 * obligations that actually apply.
 *
 * ## Why a Worker and not an R2 lifecycle rule
 *
 * An R2 lifecycle rule matches on a prefix and an age in days. It cannot open
 * an object and read a field. Retention here turns on `status` — rejected for
 * twelve months, withdrawn for thirty days, approved for review after two
 * years — and that status lives inside the object bodies. A lifecycle rule
 * would have to either delete every application on one fixed schedule, which
 * would delete applications still under review, or never fire at all.
 *
 * So the decision is made here, per application, and `lib/cleanup.js` runs it on
 * a schedule.
 */

/** Retention periods, in days. The single source of truth for every period. */
export const RETENTION_DAYS = {
  /** From the final rejection decision to deletion. */
  rejected: 365,
  /** From withdrawal to deletion. */
  withdrawn: 30,
  /**
   * From approval to a human decision about whether to keep the application.
   * This is a review point, not a deletion date: see `APPROVED_NEVER_AUTODELETED`.
   */
  approvedReviewAfter: 730,
};

/**
 * An approved application is never deleted automatically, however old.
 *
 * Two reasons, and the second is the important one. First, the Associate record
 * in the repository carries `application_id` and a `consent_fingerprint`: the
 * published profile is the artefact that traces back to the answer it was built
 * from, and deleting the application severs that trace for a person who is
 * published and may be working with us. Second, the policy itself asks for a
 * decision after twenty-four months rather than a deletion.
 *
 * After that point the sweep raises the application for a person. It does not
 * remove it.
 */
export const APPROVED_NEVER_AUTODELETED =
  "An approved application is retained until a person decides otherwise. It is never deleted automatically.";

/** Actions the sweep knows how to carry out. */
export const ACTIONS = {
  KEEP: "keep",
  DELETE: "delete-application",
  DISCARD_UPLOADS: "discard-uploads",
  REVIEW: "review",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Add days to a timestamp.
 *
 * Calendar days rather than a fixed 30-day block, so "twelve months" reads as
 * the same date the following year and a run on the 29th of a month still lands
 * on a valid date.
 *
 * Returns null rather than throwing on a bad day count. A caller indexing the
 * wrong key would otherwise take down the page that reports when a deletion is
 * due, which is a worse outcome than showing no date.
 */
export function addDays(iso, days) {
  const start = Date.parse(iso);
  if (!Number.isFinite(start) || !Number.isFinite(days)) return null;
  return new Date(start + days * DAY_MS).toISOString();
}

/**
 * Whole days between two timestamps, or null if either is unusable.
 *
 * Rounded down: an application is due the day *after* its period ends, never on
 * the day it ends, so a sweep cannot delete something a day early because of
 * rounding.
 */
export function daysSince(iso, now) {
  const then = Date.parse(iso);
  const current = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return null;
  return Math.floor((current - then) / DAY_MS);
}

/**
 * When a decision was made, read from the dedicated stamp.
 *
 * The fallback chain matters for records that predate the stamps. An older
 * rejected application has a history entry but no `rejected_at`, and falling back
 * to the matching history entry dates it properly instead of treating it as
 * undatable and keeping it forever. `updated_at` is last, and only because it is
 * the one field every record has.
 */
export function decisionAt(review, status) {
  const stamp = { rejected: "rejected_at", withdrawn: "withdrawn_at", approved: "approved_at" }[status];
  if (!review || !stamp) return null;
  if (review[stamp]) return review[stamp];

  const entry = (review.history || [])
    .filter((item) => item && item.to === status)
    .map((item) => item.at)
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort();
  if (entry.length) return entry[entry.length - 1];

  return review.updated_at || review.created_at || null;
}

/**
 * Is a documented hold in force?
 *
 * A hold needs both a date and a reason. A bare date is treated as no hold, so
 * clearing the reason field in the dashboard releases the application rather
 * than deleting it on a date nobody can account for.
 */
export function holdInForce(review, now) {
  if (!review?.retention_hold_until || !review?.retention_hold_reason) return null;
  const until = Date.parse(review.retention_hold_until);
  if (!Number.isFinite(until)) return null;
  if (Date.parse(now) < until) {
    return { until: review.retention_hold_until, reason: review.retention_hold_reason };
  }
  return null;
}

/**
 * Which uploaded files, if any, are no longer needed.
 *
 * The CV and the photograph are treated differently because their futures
 * differ. The photograph is the source for the public profile image, and
 * publication copies it into the repository — so once it is published, or once
 * the applicant declined publication and it can never be published, the R2
 * original is redundant. The CV is never published and is of no further use
 * once the Associate record exists.
 *
 * Nothing is discarded while a review is live, or before the record exists:
 * a photograph that has not been published yet is the only copy of it.
 */
export function discardableUploads(review, consent) {
  if (!review?.associate_id) return { files: [], reason: "no Associate record has been created yet" };
  if (review.uploads_discarded_at) return { files: [], reason: "the uploads were already discarded" };

  const files = ["cv"];

  if (consent !== true) {
    // The applicant declined publication, so the photograph can never become
    // the public profile image.
    files.push("photo");
  } else if (review.associate_photo_at) {
    // Published: the image now lives in the repository, so the R2 copy is a
    // duplicate of something safely transferred.
    files.push("photo");
  } else {
    // Consent given, photograph not yet published. It is still the only copy.
    files.length = 1;
  }

  return { files, reason: "" };
}

/**
 * Decide what should happen to one application.
 *
 * @param {object} input
 * @param {object|null} input.application The application record, if readable.
 * @param {object|null} input.review     The review state, if there is one.
 * @param {string}   input.now           An ISO timestamp, so tests can pin it.
 * @param {boolean}  input.consent       The applicant's publication answer.
 * @returns {{action: string, reason: string, deleteAfter: string|null, files: string[]}}
 */
export function decide({ application, review, now, consent = null }) {
  const keep = (reason, extra = {}) => ({ action: ACTIONS.KEEP, reason, deleteAfter: null, files: [], ...extra });

  // An application with no review state has no decision, so it is not finished
  // with. Deleting it would destroy an application nobody has looked at.
  if (!review) {
    return keep(
      application
        ? "no review decision has been recorded, so the application is still open"
        : "the application record could not be read, so it is left alone",
    );
  }

  const hold = holdInForce(review, now);
  if (hold) {
    return keep(`deletion is held until ${hold.until}: ${hold.reason}`, { hold });
  }

  const status = review.status;

  if (status === "rejected" || status === "withdrawn") {
    const period = RETENTION_DAYS[status];
    const decidedAt = decisionAt(review, status);
    if (!decidedAt) {
      return keep(`${status}, but no decision date is recorded, so the clock cannot be read`);
    }
    const age = daysSince(decidedAt, now);
    const deleteAfter = addDays(decidedAt, period);
    if (age !== null && age >= period) {
      return {
        action: ACTIONS.DELETE,
        reason: `${status} ${age} days ago, past the ${period}-day retention period`,
        deleteAfter,
        files: [],
      };
    }
    return keep(
      `${status} ${age ?? "an unknown number of"} days ago, inside the ${period}-day retention period`,
      { deleteAfter },
    );
  }

  if (status === "approved") {
    const decidedAt = decisionAt(review, "approved");
    const age = decidedAt ? daysSince(decidedAt, now) : null;

    // Uploads are only ever discarded from an approved application, and only
    // once they have no further use.
    const { files, reason: whyNot } = discardableUploads(review, consent);

    if (files.length && (age === null || age >= RETENTION_DAYS.approvedReviewAfter)) {
      return {
        action: ACTIONS.DISCARD_UPLOADS,
        reason: `approved ${age ?? "an unknown number of"} days ago; the application itself is kept (${APPROVED_NEVER_AUTODELETED}) Removing the uploads, which are no longer needed: ${files.join(" and ")}`,
        deleteAfter: null,
        files,
      };
    }

    if (age !== null && age >= RETENTION_DAYS.approvedReviewAfter) {
      return {
        action: ACTIONS.REVIEW,
        reason: `${APPROVED_NEVER_AUTODELETED} Approved ${age} days ago.`,
        deleteAfter: null,
        files: [],
      };
    }

    return keep(
      files.length
        ? `approved ${age ?? "an unknown number of"} days ago; uploads kept (${whyNot || "still within the review period"})`
        : `approved ${age ?? "an unknown number of"} days ago, inside the ${RETENTION_DAYS.approvedReviewAfter}-day review period`,
      { deleteAfter: decidedAt ? addDays(decidedAt, RETENTION_DAYS.approvedReviewAfter) : null },
    );
  }

  // submitted, under-review, changes-requested, archived: a live queue, or a
  // record a person parked. Neither is the sweep's to delete.
  return keep(`${status}, which is not an ended application`);
}

/** The policy as data, for the documentation and the dashboard. */
export const POLICY = [
  {
    status: "Rejected",
    period: `${RETENTION_DAYS.rejected} days (12 months)`,
    countedFrom: "the final rejection decision",
    outcome: "the application record, its CV and its photograph are deleted",
  },
  {
    status: "Withdrawn",
    period: `${RETENTION_DAYS.withdrawn} days`,
    countedFrom: "the withdrawal",
    outcome: "the application record, its CV and its photograph are deleted",
  },
  {
    status: "Approved",
    period: `${RETENTION_DAYS.approvedReviewAfter} days (24 months)`,
    countedFrom: "approval",
    outcome: "raised for a person to decide; never deleted automatically. The CV, and the photograph once it is published or was never publishable, are removed",
  },
  {
    status: "Under review",
    period: "no limit",
    countedFrom: "—",
    outcome: "kept in full",
  },
];
