/**
 * Publishing an applicant's photograph.
 *
 * Approval does not do this. An applicant's picture is their own, it is the most
 * personal thing an application contains, and copying it into a repository that
 * publishes to a website is a decision a person should make on purpose. So the
 * photograph has its own button, behind the same consent check as publication,
 * and an approved record is created with no `photo` at all.
 *
 * ## Why this is not a redesign
 *
 * The site's image architecture is one folder and one field: files live in
 * `static/images/` and a record names one in `photo`. Writing a file there
 * through the same Contents API the YAML record uses is the same operation with
 * base64 bytes instead of text, so no template, no partial and no page changes.
 * The file is named after the associate id, which is already unique, so a
 * photograph can never overwrite somebody else's.
 *
 * If this ever stops being safe — a different storage route, a file too large to
 * put through the API — the honest answer is to leave it as a manual step and say
 * so, which is what the dashboard does when there is no photograph on the
 * application at all. Nothing here is required for a person to be published: a
 * profile with no photograph is a valid record, and the templates fall back to
 * their placeholder.
 *
 * ## What the private copy is
 *
 * The object in R2 is never moved, copied to a public URL, or handed out. The
 * dashboard keeps streaming it to signed-in reviewers at `/file/<id>?kind=photo`
 * for as long as the application exists. Publishing copies one file into the
 * site; it does not expose the application.
 */

import { readApplication, readReview, consentOf } from "./store.js";
import { readTextFile, readFileSha, writeTextFile, writeBinaryFile, associatePath, imagePath } from "./repository.js";
import { setYamlScalar, readYamlScalar } from "./associate.js";

/** The same types the submissions Worker accepts, and nothing else. */
const EXTENSION_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The intake limit. A photograph that arrived is within it; a safety net anyway. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Copy the applicant's photograph into the site and point the record at it.
 *
 * Result `code` values, as in `lib/approval.js`:
 *
 *   no-application / not-approved / no-consent / no-photograph
 *   already            the record already shows this photograph
 *   too-large          the object is over the intake limit
 *   unsupported-type   the stored object is not a type the site publishes
 *   unavailable / conflict / written
 */
export async function publishPhotograph(env, { id, reviewer }) {
  const application = await readApplication(env, id);
  if (!application) {
    return refused("no-application", "The application could not be read from storage.");
  }

  const review = await readReview(env, id);
  if (!review?.associate_id) {
    return refused("not-approved", "Approve the application first; the photograph belongs to the Associate record.");
  }

  // Same authority as publication: the stored answer, read now.
  if (consentOf(application) !== true) {
    return {
      ...refused("no-consent", "The applicant did not consent to a public profile, so their photograph is not published."),
      httpStatus: 403,
    };
  }

  const file = application.files?.photo;
  if (!file?.key) {
    return refused("no-photograph", "This application has no photograph.");
  }
  if (!String(file.key).startsWith(`applications/${id}/photo/`)) {
    // The key comes from the stored record, but it is still checked: a key
    // pointing anywhere else in the bucket must not be readable from here.
    return refused("no-photograph", "The stored photograph is not where it should be, so it was not published.");
  }

  const type = String(file.contentType || "").toLowerCase();
  const extension = EXTENSION_BY_TYPE[type];
  if (!extension) {
    return refused("unsupported-type", `A ${type || "photograph of unknown type"} cannot be published. Use a JPEG, PNG or WebP.`);
  }

  const object = await env.APPLICATIONS.get(file.key);
  if (!object) {
    return { ...refused("unavailable", "The photograph could not be read from storage."), httpStatus: 502 };
  }

  // A view, not the buffer itself: the base64 encoder walks the bytes, and an
  // ArrayBuffer is not iterable.
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength === 0) {
    return refused("unavailable", "The photograph in storage is empty.");
  }
  if (bytes.byteLength > MAX_BYTES) {
    return refused("too-large", `The photograph is ${Math.round(bytes.byteLength / 1024 / 1024)} MB. The limit is 8 MB.`);
  }

  const associateId = review.associate_id;
  const name = `${associateId}.${extension}`;
  const recordPath = associatePath(associateId);

  const record = await readTextFile(env, recordPath, { fresh: true });
  if (!record.ok) return { ...refused("unavailable", record.reason), httpStatus: 502 };
  if (record.missing) {
    return refused("record-missing", `The record ${recordPath} is not in the repository.`);
  }

  const currentPhoto = readYamlScalar(record.text, "photo");
  if (currentPhoto === `/images/${name}`) {
    return { outcome: "already", associateId, message: `The record already shows this photograph at /images/${name}.` };
  }

  // The image is written before the record names it. The other order would leave
  // a public profile pointing at a file that is not there if the second write
  // failed; this way a failure leaves an unused file, which costs nothing.
  // An existing file is an update, not a create. A photograph whose first
  // attempt wrote the bytes and then failed to link them is otherwise
  // unpublishable: every retry would be refused for trying to overwrite it.
  const existing = await readFileSha(env, imagePath(name));
  if (!existing.ok) {
    return { ...refused("unavailable", existing.reason), httpStatus: 502 };
  }

  const imageWrite = await writeBinaryFile(env, imagePath(name), bytes, {
    message: `Add ${name}, the photograph for ${associateId} from application ${id}`,
    sha: existing.missing ? null : existing.sha,
  });
  if (!imageWrite.ok) {
    return {
      ...refused(imageWrite.kind === "conflict" ? "conflict" : "unavailable", imageWrite.reason),
      httpStatus: imageWrite.kind === "conflict" ? 409 : 502,
    };
  }

  // The record names the image, and the alt text is the person's own name, which
  // is what the existing records do. Nothing here is invented.
  const displayName = String(application.fields?.name || "").trim();
  let text = record.text;
  const photoEdit = setYamlScalar(text, "photo", `/images/${name}`);
  if (photoEdit.error) return { ...refused("conflict", photoEdit.error), httpStatus: 409 };
  text = photoEdit.text;

  const altEdit = setYamlScalar(text, "photo_alt", displayName);
  if (altEdit.error) return { ...refused("conflict", altEdit.error), httpStatus: 409 };
  text = altEdit.text;

  const recordWrite = await writeTextFile(env, recordPath, text, {
    message: `Show the published photograph on ${associateId} from application ${id}`,
    sha: record.sha,
  });
  if (!recordWrite.ok) {
    return {
      ...refused(recordWrite.kind === "conflict" ? "conflict" : "unavailable", recordWrite.reason),
      httpStatus: recordWrite.kind === "conflict" ? 409 : 502,
    };
  }

  return {
    outcome: "written",
    associateId,
    photo: `/images/${name}`,
    message: `The photograph is now at static/images/${name} and the record shows it. The private copy in R2 is unchanged.`,
  };
}

function refused(code, message) {
  return { outcome: "refused", code, message, httpStatus: 409 };
}
