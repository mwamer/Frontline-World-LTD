/**
 * Approving an application and creating the Associate record.
 *
 * This is the step that makes the dashboard a workflow rather than a viewer. It
 * takes an application out of R2 and puts a person into `data/associates/`,
 * without a human copying anything.
 *
 * ## The order of the checks, and why
 *
 * The sequence below is deliberate. Each step refuses rather than continuing on
 * a doubt, and the two that can silently do damage — writing over an existing
 * person, and writing without a write token — are both checked before anything
 * is built.
 *
 *   1. the application is in R2                 no application, nothing to approve
 *   2. the vocabulary could be read             no vocabulary, no valid terms
 *   3. the existing records could be listed     no list, no id can be trusted
 *   4. this application has no record yet       approving twice changes nothing
 *   5. the id is free                           no collision with a real person
 *   6. the write token is configured            no token, no silent no-op
 *   7. the record is written
 *
 * Step 3 is the one worth dwelling on. Asking GitHub which people already exist
 * can fail for reasons that have nothing to do with this application — a rate
 * limit, a network blip, a token without access to the directory. An earlier
 * version of this treated that as "no existing records", which meant a transient
 * failure would mint a second record for a person who already had one. Here the
 * two answers stay distinct: `ok: false` stops the approval and tells the
 * reviewer to try again. A refusal is a better outcome than a duplicate.
 *
 * ## What is copied, and what is not
 *
 * The record carries the professional fields: name, title, organisation, the
 * summaries, the biography, the vocabulary terms, the list fields and the
 * professional links. It does not carry the applicant's email address, their
 * current position as stated on the form, their availability or constraints,
 * their delivery or audience preferences, their portfolio, or anything else the
 * application collected for the review. None of that is public-facing, and a
 * record in `data/associates/` is published in full.
 *
 * It also does not carry a photograph. That is a separate, deliberate step in
 * `lib/photograph.js`, because putting a person's picture into a public
 * repository is a publication decision and not a consequence of being accepted.
 *
 * ## Idempotency
 *
 * Approving twice must not create two people. The review state in R2 holds the
 * `associate_id` this application produced, and that is the first thing checked.
 * A second approval returns the same record and writes nothing — no second
 * commit, no `-2` suffix, no second person on the site.
 */

import {
  readApplication,
  readReview,
  emptyReview,
  saveReview,
  consentOf,
  consentFingerprint,
} from "./store.js";
import { draftAssociate, suggestAssociateId, toYaml } from "./associate.js";
import { listAssociateIds, readVocabulary, readTextFile, writeTextFile, associatePath } from "./repository.js";

/**
 * Approve an application and create its Associate record.
 *
 * `id` is the application id; `reviewer` is the signed-in account. Returns a
 * result object rather than throwing, so every failure is a value the caller
 * turns into a deliberate response.
 *
 * `code` values:
 *
 *   no-application          the application is not in R2
 *   vocabulary-unavailable  the vocabulary file is missing or unreadable  → 502
 *   repository-unavailable  the repository would not answer                   → 503
 *   duplicates-unverifiable the existing records could not be listed   → 503
 *   already                 approved before; the same record is returned → 200
 *   record-missing          the review names a record Git does not have → 409
 *   id-taken                the id collides with a real, unrelated record
 *   not-configured          no repository token on this Worker
 *   conflict                GitHub refused the write                  → 409
 *   not-configured          the token is missing or refused           → 503
 *   unavailable             the write could not be completed          → 502
 *   written                 the record was created                    → 200
 */
export async function approveAndCreate(env, { id, reviewer, note = "" }) {
  // 1. The application. Everything after this point works from this object and
  //    nothing else, so the R2 record is the single source for the decision.
  const application = await readApplication(env, id);
  if (!application) {
    return refused("no-application", "The application could not be read from storage, so nothing was approved.");
  }

  const existing = (await readReview(env, id)) || emptyReview(reviewer);
  const consent = consentOf(application);

  // 4. Already approved. This is the idempotency check, and it comes before any
  //    GitHub call so that a second click costs nothing and cannot race the
  //    first one into a second record.
  if (existing.associate_id) {
    const file = await readTextFile(env, associatePath(existing.associate_id), { fresh: true });
    if (!file.ok) {
      return { ...refused("unavailable", file.reason), httpStatus: 502 };
    }
    if (file.missing) {
      // The review says there is a record and the repository says there is not.
      // Creating another would be the worst possible response to that, so it is
      // reported and a person resolves it.
      return {
        ...refused(
          "record-missing",
          `This application already produced ${existing.associate_id}, but that file is not in the repository. It was not created a second time. Restore the record or clear the link on this application.`
        ),
        httpStatus: 409,
      };
    }
    return {
      outcome: "already",
      associateId: existing.associate_id,
      publicationPermitted: consent,
      message: `${existing.associate_id} was already created from this application. Nothing was written again.`,
    };
  }

  // 2. The vocabulary. Without it no term on the record can be validated, and a
  //    record built with unvalidated terms is worse than no record.
  const vocabularyResult = await readVocabulary(env, { fresh: true });
  if (!vocabularyResult.ok) {
    // A repository that will not answer is an outage and reads as 503; one that
    // answers with a file we cannot use is a content fault and reads as 502.
    if (vocabularyResult.kind === "unreachable") {
      return {
        ...refused("repository-unavailable", `The repository could not be reached, so nothing was written. ${vocabularyResult.reason}`),
        httpStatus: 503,
      };
    }
    return { ...refused("vocabulary-unavailable", vocabularyResult.reason), httpStatus: 502 };
  }

  // 3. The existing records. Fails closed: see the note at the top of this file.
  const directory = await listAssociateIds(env, { fresh: true });
  if (!directory.ok) {
    return {
      ...refused(
        "duplicates-unverifiable",
        `Unable to verify existing Associate records, so no record was created. ${directory.reason}`
      ),
      httpStatus: 503,
    };
  }

  // 5. The id, checked against what actually exists.
  const associateId = suggestAssociateId(application.fields?.name, directory.ids);

  // Git is the real authority on whether the file exists, so ask it directly as
  // well. A file at this path that the review knows nothing about is a person we
  // must not overwrite, whatever the slug suggests.
  const target = associatePath(associateId);
  const collision = await readTextFile(env, target, { fresh: true });
  if (!collision.ok) {
    return { ...refused("unavailable", collision.reason), httpStatus: 502 };
  }
  if (!collision.missing) {
    return {
      ...refused("id-taken", `The record ${target} already exists and this application is not the one that created it. Nothing was changed.`),
      httpStatus: 409,
    };
  }

  // 6. The record, assembled from the application and the vocabulary.
  const fingerprint = await consentFingerprint(application);
  const now = new Date().toISOString();
  const draft = draftAssociate(application, associateId, vocabularyResult.vocabulary, {
    consentFingerprint: fingerprint,
    approvedAt: now,
    approvedBy: reviewer,
  });

  // 7. The write. A create with no sha, so GitHub itself refuses if the file
  //    appeared in the meantime rather than overwriting it.
  const written = await writeTextFile(env, target, toYaml(draft.record), {
    message: `Add ${associateId} from application ${id}`,
  });

  if (!written.ok) {
    const code = written.kind === "conflict" ? "conflict" : written.kind === "unauthorised" ? "not-configured" : "unavailable";
    return {
      ...refused(code, written.reason),
      httpStatus: code === "conflict" ? 409 : code === "not-configured" ? 503 : 502,
    };
  }

  // The application is marked approved here rather than by the generic status
  // route, so "approved" and "has a record" are the same event and cannot drift.
  await saveReview(
    env,
    id,
    application,
    {
      status: "approved",
      associate_id: associateId,
      associate_visibility: "private",
      associate_created_at: now,
      associate_created_by: reviewer,
      consent_fingerprint: fingerprint,
      historyAction: "associate_created",
      historyNote: note || `Associate record ${associateId} created.`,
    },
    reviewer
  );

  return {
    outcome: "written",
    associateId,
    publicationPermitted: consent,
    path: target,
    message: `${associateId} created as a private Associate. Publish them from this page when you are ready.`,
  };
}

function refused(code, message) {
  return { outcome: "refused", code, message, httpStatus: 409 };
}
