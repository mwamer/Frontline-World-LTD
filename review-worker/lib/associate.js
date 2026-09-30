/**
 * Turning an approved application into an Associate record.
 *
 * The central record in `data/associates/` stays the authoritative person
 * record. This module builds that file from the application held in R2: it
 * copies the public professional fields across, keeps the application's own id
 * on the record so an associate can be traced back to the application it came
 * from, and carries the applicant's publication consent across from the stored
 * answer rather than from anything a reviewer typed.
 *
 * Nothing here reads a request. The record is assembled from the application
 * record and the vocabulary file, and handed to `lib/repository.js` to be
 * written. A browser cannot choose a path or supply a line of the file.
 *
 * ## The vocabulary is read, not mirrored
 *
 * An earlier version of this module carried its own copy of the term lists.
 * That was two editable sources for one set of ids, and the copy would drift.
 * The ids now come from `data/vocab/associates.yml` — the file the site, the
 * CMS select options and the directory filters already read — passed in by the
 * caller. A term added there reaches a new record with no change here.
 *
 * ## The consent fields in the record are a copy, not the authority
 *
 * `publication_permitted` in the YAML is a faithful copy of the applicant's
 * answer, kept so the record explains itself and so the Hugo gate has something
 * to read, and `consent_fingerprint` is a digest of the consent facts as they
 * were held in R2 at the moment of approval. The answer as the applicant worded
 * it, and the moment they gave it, are not copied: this file is published, and a
 * published record holds no administrative detail. Neither field is a lock:
 * someone with write access to the repository can edit any line of any record.
 * What actually prevents publication is `POST /application/:id/publication`,
 * which re-reads the application from R2 and refuses when the answer there is
 * not yes, and the Hugo gate, which needs the field to be true. The copy is for
 * traceability; the check is in the Worker and in the build.
 *
 * ## The photograph stays out of this
 *
 * A record is created with no `photo`, even when the application has one. The
 * photograph is written to `static/images/` by a separate, deliberate
 * publication step (`lib/photograph.js`), because copying an applicant's picture
 * into a public repository is a publication decision and not a side effect of
 * being accepted.
 */

/**
 * Build the record for an approved application.
 *
 * `associateId` is the file name, which becomes the profile URL and the id a
 * course refers to, so the caller checks it for collisions first.
 *
 * `vocabulary` is the parsed `data/vocab/associates.yml`, used to drop any term
 * the repository does not define — the same rule the site's own templates
 * apply, so a record cannot carry a tag that would render as nothing.
 *
 * `provenance` carries the approval facts, all of which the caller takes from
 * R2 and the signed-in reviewer.
 */
export function draftAssociate(application, associateId, vocabulary, provenance = {}) {
  const fields = application?.fields || {};
  const consent = application?.consent || {};

  const record = {
    application_id: application?.id || null,
    name: clean(fields.name),
    title: clean(fields.title),
    organisation: clean(fields.organisation),
    summary: clean(fields.bio_short),
    bio: toParagraphs(fields.bio_long),
    expertise: terms("expertise", fields.expertise, vocabulary),
    roles: terms("roles", fields.roles, vocabulary),
    contributions: terms("contributions", fields.contributions, vocabulary),
    sectors: terms("sectors", fields.sectors, vocabulary),
    regions: terms("regions", fields.regions, vocabulary),
    countries: toLines(fields.countries),
    qualifications: toLines(fields.qualifications),
    experience: toLines(fields.experience),
    teaching_subjects: toLines(fields.teaching_subjects),
    languages: toLines(fields.languages),
    links: buildLinks(fields),

    // ---- Provenance, in the record so the record explains itself ----------
    //
    // The record is a file in a public repository, and every field in it is
    // published, so it carries the consent *decision* and a digest of it, never
    // the answer as the applicant worded it or the moment they gave it. Those
    // two stay in the private record in R2, which is where the dashboard reads
    // them from and where they belong.
    publication_permitted: consent.publication_permitted === true,
    consent_fingerprint: clean(provenance.consentFingerprint) || null,
    approved_at: clean(provenance.approvedAt) || null,
    approved_by: clean(provenance.approvedBy) || null,

    // ---- Publication state ------------------------------------------------
    //
    // An approval creates a person; it does not publish one. The record starts
    // private and inactive, so a record written a second ago cannot be on the
    // public site by accident: the gate needs both fields, and publication has
    // to set both deliberately.
    visibility: "private",
    profile_status: "inactive",

    // Puts a new person below everyone already in the directory, so an
    // approval never displaces an existing entry.
    weight: 900,
  };

  return { id: associateId, record };
}

/**
 * A stable id for the person, in the repository's existing convention: the name,
 * lower-cased, with anything that is not a letter or a digit turned into a
 * single hyphen. `wesam-amer`, `saeed-abuzour`.
 *
 * Not the name alone as a unique key — two people can share a name, and a
 * surname can change — so a collision with an existing record appends a
 * counter. The application id is kept on the record either way, which is what
 * makes the link from associate back to application reliable.
 *
 * `takenIds` must come from a successful `listAssociateIds()`. An empty list
 * here means "there are no records", never "I could not check"; the caller is
 * responsible for having established which one it has, and refuses to call this
 * at all when the answer is unknown.
 */
export function suggestAssociateId(name, takenIds = []) {
  const base = slug(name) || "associate";
  const taken = new Set(takenIds.map((id) => String(id).toLowerCase()));

  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function slug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop combining marks, so "Sáeed" becomes "saeed"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Keep only the terms the repository's own vocabulary defines, in the
 * applicant's order.
 *
 * The applicant's free text is normalised to an id the same way the site's
 * filters do, so "Education & Training" and `education-training` both arrive as
 * the one term. Anything the vocabulary does not list is dropped, which is what
 * the templates do with an unknown id anyway — it keeps the record honest
 * rather than carrying a tag that renders as nothing.
 */
function terms(list, value, vocabulary) {
  const allowed = new Set((vocabulary?.[list] || []).map((id) => String(id).toLowerCase()));
  if (!allowed.size) return [];
  return toLines(value)
    .map((item) => item.toLowerCase().replace(/&/g, "and").replace(/[\s_/]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, ""))
    .filter((item) => allowed.has(item));
}

/** A multi-line textarea becomes a list, one entry per non-empty line. */
function toLines(value) {
  if (Array.isArray(value)) {
    return value.map((item) => clean(item)).filter(Boolean);
  }
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => clean(line))
    .filter(Boolean);
}

/** A biography is a list of paragraphs, which is what a record stores. */
function toParagraphs(value) {
  return String(value || "")
    .split(/\n\s*\n/)
    .map((paragraph) => clean(paragraph))
    .filter(Boolean);
}

function clean(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function buildLinks(fields) {
  const links = [];
  if (clean(fields.website)) links.push({ label: "Personal website", url: clean(fields.website) });
  if (clean(fields.linkedin)) links.push({ label: "LinkedIn", url: clean(fields.linkedin) });
  return links;
}

/**
 * The record as YAML.
 *
 * A hand-rolled serialiser rather than a dependency, and it is deliberately
 * conservative: it quotes anything that could be read as structure, so a name
 * like `Dr. Ana: Silva` or a biography containing a colon stays a string. It
 * writes a fixed set of keys in a fixed order, which is also what makes writing
 * the file again to change one field safe — the output is a pure function of the
 * record, so an update is a full rewrite from the parsed record, never a patch
 * against whatever was in the file.
 */
export function toYaml(record) {
  const lines = [];
  const emit = (key, value) => lines.push(`${key}: ${scalar(value)}`);
  const emitOptional = (key, value) => {
    if (value !== null && value !== undefined && value !== "") lines.push(`${key}: ${scalar(value)}`);
  };

  emit("application_id", record.application_id);
  emit("name", record.name);
  emit("title", record.title);
  emit("organisation", record.organisation);
  emitOptional("photo", record.photo);
  emitOptional("photo_alt", record.photo_alt);
  emit("summary", record.summary);

  if (record.bio?.length) {
    lines.push("bio:");
    for (const paragraph of record.bio) {
      lines.push("  - >-");
      for (const wrapped of wrap(paragraph, 72)) lines.push(`      ${wrapped}`);
    }
  }

  for (const key of [
    "expertise", "roles", "contributions", "sectors", "regions",
    "countries", "qualifications", "experience", "teaching_subjects", "languages",
  ]) {
    if (record[key] && record[key].length) {
      lines.push(`${key}:`);
      for (const item of record[key]) lines.push(`  - ${scalar(item)}`);
    }
  }

  if (record.links?.length) {
    lines.push("links:");
    for (const link of record.links) {
      lines.push(`  - label: ${scalar(link.label)}`);
      lines.push(`    url: ${scalar(link.url)}`);
    }
  }

  // The consent decision and the approval that acted on it, so the record says
  // which application it came from and on what basis. Read by a person, and by
  // the publication gate, which only ever looks at publication_permitted. The
  // answer itself and its timestamp stay in the private record in R2.
  emit("publication_permitted", record.publication_permitted);
  emitOptional("consent_fingerprint", record.consent_fingerprint);
  emitOptional("approved_at", record.approved_at);
  emitOptional("approved_by", record.approved_by);

  emit("visibility", record.visibility);
  emit("profile_status", record.profile_status);
  if (record.weight !== undefined && record.weight !== null) emit("weight", record.weight);

  return lines.join("\n") + "\n";
}

/**
 * Change one top-level scalar in an existing record, leaving the rest of the
 * file exactly as it is.
 *
 * The alternative — rebuilding the record from the application and writing that
 * — would silently undo anything a person changed through the CMS after the
 * record was created: a tightened summary, a corrected title, a photograph. So
 * publication edits the one line it means to change and writes the rest back
 * untouched, comments, ordering, bio formatting and all.
 *
 * The match is anchored to the start of a line and requires no indentation, so
 * it cannot match a nested key that happens to share the name. A record with
 * duplicate top-level keys is refused rather than guessed at, because in YAML
 * the second one wins and we would not be editing the one Hugo reads.
 *
 * Returns `{ text }` on success or `{ error }` with the reason.
 */
export function setYamlScalar(text, key, value) {
  const source = String(text ?? "");
  const pattern = new RegExp(`^${escapeRegExp(key)}:(.*)$`, "gm");
  const matches = source.match(pattern);

  if (matches && matches.length > 1) {
    return { error: `The record sets ${key} more than once, so it was left alone.` };
  }

  const rendered = `${key}: ${scalar(value)}`;

  if (matches) {
    return { text: source.replace(pattern, rendered) };
  }
  // No such key yet: add it at the end, where a reader will look for it.
  const withNewline = source.endsWith("\n") || source === "" ? source : `${source}\n`;
  return { text: `${withNewline}${rendered}\n` };
}

/** Read one top-level scalar back out of a record, for verification. */
export function readYamlScalar(text, key) {
  const source = String(text ?? "");
  const pattern = new RegExp(`^${escapeRegExp(key)}:[ \\t]*(.*)$`, "m");
  const match = source.match(pattern);
  if (!match) return null;
  const value = match[1].trim();
  if (value === '""' || value === "''") return "";
  if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null || value === undefined) return '""';

  const text = String(value);
  if (text === "") return '""';

  // Anything that YAML could read as structure, a type or a marker is quoted.
  const needsQuotes =
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /:\s/.test(text) ||
    /\s#/.test(text) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(text) ||
    /^\s|\s$/.test(text) ||
    /^-?\d+(\.\d+)?$/.test(text);

  if (!needsQuotes) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}
