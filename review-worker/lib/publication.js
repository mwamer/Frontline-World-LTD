/**
 * Deciding whether a person may appear on the public site.
 *
 * This is the part of the workflow that has to be a technical constraint rather
 * than a promise, so it is worth being exact about where the constraint lives.
 *
 * ## Where the authority is
 *
 * The applicant's answer to "may we publish a profile?" was written once, by the
 * submissions Worker, into `applications/<id>/application.json`. That record is
 * the authority. Every decision here starts by reading it fresh from R2:
 *
 *   1. read the application from R2 — the stored `consent.publication_permitted`
 *   2. if it is not `true`, refuse. There is no path to a public record.
 *   3. only then change the associate record in the repository
 *
 * Step 2 gates publishing and nothing else. Taking a profile back down is
 * always permitted, so a record made public by hand in the CMS can still be
 * removed — a consent rule that could lock someone onto the website would be
 * worse than no rule.
 *
 * Nothing the browser sends is consulted. A POST carrying
 * `publication_permitted=true`, a form field named `consent`, or a `visibility`
 * the caller would like to be `public` is read by nothing here. The only input
 * is which of the two buttons was pressed, and even that is checked against a
 * fixed set.
 *
 * ## Why the record is not trusted
 *
 * `publication_permitted` also sits in `data/associates/<id>.yml`, because the
 * Hugo gate needs it and the record should explain itself. It is a copy, and a
 * copy is only as trustworthy as whoever maintains it — which is to say, a
 * repository administrator could change it. That is why publication does not
 * read it. It is also why the consent fingerprint is compared: if the R2
 * consent block is not the one the record was approved against, the reviewer is
 * told to look again rather than being asked to make a decision about a
 * consent answer nobody can now identify.
 *
 * To be plain about the limit: someone who can push to this repository can
 * still publish anyone by hand. The control here removes the dashboard from that
 * path, not the repository owner from their own repository.
 *
 * ## The two states, and why they are separate
 *
 * Application status and publication are different decisions about different
 * things. "Approved" says a person was accepted into the network. "Public" says
 * their profile is on the website today. A person can be approved and private
 * for as long as it takes to check a photograph, and can be made private again
 * the moment that stops being right. Collapsing them into one field would mean
 * un-publishing a person had to be recorded as withdrawing their application.
 */

import { readApplication, readReview, consentOf, consentFingerprint } from "./store.js";
import { readTextFile, writeTextFile, associatePath } from "./repository.js";
import { setYamlScalar, readYamlScalar } from "./associate.js";

/** The only two things a reviewer may ask for. Anything else is not an action. */
export const PUBLICATION_ACTIONS = ["public", "private"];

/**
 * Publish, or unpublish, the associate record for an application.
 *
 * Returns a result object. Every refusal is a `refused` with a `code`, so a test
 * can assert on the reason rather than on a sentence, and so the caller can
 * choose the status code without this module knowing about HTTP.
 *
 * `code` values:
 *
 *   no-application     the application is not in R2
 *   not-approved       the application has not been approved, or has no record
 *   no-consent         publishing: the applicant did not consent             → 403
 *   record-says-no     publishing: the record's own copy says no            → 409
 *   consent-changed    R2 consent is not what the record was built from     → 409
 *   record-unreadable  the record in Git could not be read                   → 502
 *   record-missing     the record named by the review is not in Git          → 409
 *   already            it is already in the state asked for                  → 200
 *   written            the record was changed                               → 200
 *   conflict           GitHub refused the write                             → 409
 *   unavailable        the repository could not be reached                  → 502
 *
 *   `no-consent` and `record-says-no` apply to `action=public` only. Both
 *   return 200-ish outcomes for `action=private`, which never needs consent.
 */
export async function setPublication(env, { id, action, reviewer }) {
  if (!PUBLICATION_ACTIONS.includes(action)) {
    return refused("unknown-action", `That is not a publication action.`);
  }

  // 1. The application, and therefore the consent, straight from R2.
  const application = await readApplication(env, id);
  if (!application) {
    return refused("no-application", "The application could not be read from storage, so nothing was changed.");
  }

  // 2. The associate record this application produced.
  const review = await readReview(env, id);
  if (!review?.associate_id) {
    return refused("not-approved", "This application has no Associate record yet. Approve it first.");
  }

  // 3. Consent, from the record, not from the request and not from the CMS copy.
  //    Read before the record, and applied only to publishing.
  //
  //    Consent gates one direction. Making a profile private is always allowed,
  //    because a record that should not be on the website has to be removable
  //    whatever the consent says — including when the answer is no and the record
  //    was made public by hand in the CMS. Blocking that would mean the consent
  //    rule could leave someone exposed who could not otherwise be taken down.
  const permitted = consentOf(application);
  if (action === "public" && permitted !== true) {
    return {
      ...refused(
        "no-consent",
        permitted === false
          ? "The applicant did not consent to a public profile, so this person cannot be published. The record stays private."
          : "This application records no consent answer, so publication is treated as not permitted."
      ),
      // 403 is the point of the whole exercise: a valid reviewer, a well-formed
      // request, and a refusal because the applicant's answer says no.
      httpStatus: 403,
    };
  }

  // 4. The current record, read fresh — the sha is what makes the write safe.
  const path = associatePath(review.associate_id);
  const file = await readTextFile(env, path, { fresh: true });
  if (!file.ok) {
    return { ...refused("record-unreadable", file.reason), httpStatus: 502 };
  }
  if (file.missing) {
    return refused("record-missing", `The record ${path} is not in the repository. It may have been removed.`);
  }

  // 5. Does the record still describe the consent we are about to act on?
  const current = await consentFingerprint(application);
  if (review.consent_fingerprint && current && review.consent_fingerprint !== current) {
    return {
      ...refused(
        "consent-changed",
        "The consent stored against this application has changed since the Associate record was created. Nothing was published. Check the application with the person before deciding again."
      ),
      httpStatus: 409,
    };
  }

  // 6. The record's own copy of consent. Read so the dashboard can report a
  //    mismatch; it is never the thing that authorises the write, and it cannot
  //    stand between a reviewer and taking a record down.
  const recordPermitted = readYamlScalar(file.text, "publication_permitted");
  if (action === "public" && recordPermitted === "false") {
    return refused(
      "record-says-no",
      "The Associate record says publication was not permitted. That is the applicant's answer, so the record was not changed. Update the application in storage if it is wrong."
    );
  }

  const currentVisibility = readYamlScalar(file.text, "visibility");
  const currentStatus = readYamlScalar(file.text, "profile_status");

  // Publishing sets both halves of the gate. Unpublishing only needs to clear
  // one, and deliberately leaves `profile_status` alone: the person is still an
  // approved, active associate, they are just not on the website today. Setting
  // it back to inactive would erase the fact that they were ever published.
  const wantedVisibility = action === "public" ? "public" : "private";
  const wantedStatus = action === "public" ? "active" : null;

  const alreadyThere = currentVisibility === wantedVisibility && (!wantedStatus || currentStatus === wantedStatus);
  if (alreadyThere) {
    return {
      outcome: "already",
      associateId: review.associate_id,
      visibility: currentVisibility,
      message: `The profile is already ${wantedVisibility}. Nothing was written.`,
    };
  }

  // 7. Change those lines, and only those lines, so a CMS edit to anything else
  //    in the record — a tightened summary, a corrected title, a photograph —
  //    survives the change.
  let text = file.text;
  const visibilityEdit = setYamlScalar(text, "visibility", wantedVisibility);
  if (visibilityEdit.error) {
    return { ...refused("record-unreadable", visibilityEdit.error), httpStatus: 409 };
  }
  text = visibilityEdit.text;

  if (wantedStatus) {
    const statusEdit = setYamlScalar(text, "profile_status", wantedStatus);
    if (statusEdit.error) {
      return { ...refused("record-unreadable", statusEdit.error), httpStatus: 409 };
    }
    text = statusEdit.text;
  }

  const written = await writeTextFile(env, path, text, {
    message: `${wantedVisibility === "public" ? "Publish" : "Unpublish"} ${review.associate_id} from application ${id}`,
    sha: file.sha,
  });

  if (!written.ok) {
    return {
      ...refused(written.kind === "conflict" ? "conflict" : "unavailable", written.reason),
      httpStatus: written.kind === "conflict" ? 409 : 502,
    };
  }

  return {
    outcome: "written",
    associateId: review.associate_id,
    visibility: wantedVisibility,
    message:
      wantedVisibility === "public"
        ? `${review.associate_id} is public. The site will show the profile once it is built.`
        : `${review.associate_id} is private again. The profile will disappear from the directory and the sitemap on the next build.`,
  };
}

function refused(code, message) {
  return { outcome: "refused", code, message, httpStatus: 409 };
}
