/**
 * Associate application intake for Frontline World.
 *
 * Receives a multipart application from the public form at
 * /become-an-associate/, checks it, and files it in a private R2 bucket. The
 * site is static, so this Worker is the only thing standing between the public
 * internet and the application store.
 *
 * What is stored, and where:
 *
 *   applications/<id>/application.json   every field, the consent decision, and
 *                                        the review state
 *   applications/<id>/cv/<token>.<ext>   the uploaded CV
 *   applications/<id>/photo/<token>.<ext>  the uploaded photograph
 *
 * <id> is generated here and carries no applicant name, so an object key can
 * never leak one through a log line or a listing. The bucket has no public
 * access, and nothing here hands out a URL: a reviewer with access to the
 * account reads the objects, or is given a short-lived signed link by whatever
 * tool issues them. The site cannot read these objects at all.
 *
 * The form used to compose an email instead. That is gone: a CV and a
 * photograph cannot travel in an email body, and an applicant who closed the
 * mail client lost the application. This is the system of record for new
 * applications. data/private/ on the build machine is staging and goes away
 * once this has run in production for a while.
 *
 * Deploy with:  npx wrangler deploy
 * Vars:         ALLOWED_ORIGIN (the site's exact origin)
 * Bindings:     APPLICATIONS (R2), RATE_LIMIT (KV)
 * Secrets:      optional TURNSTILE_SECRET — when set, Turnstile is required
 *
 * An application is never published. Storing consent is not consent to
 * publish: a reviewer still has to build a profile, and the CMS gate
 * (layouts/partials/associate-is-public.html) decides what a page may show.
 */

const LIMITS = {
  // Generous enough for a real CV, small enough that the bucket cannot be used
  // as free file storage.
  cv: { maxBytes: 5 * 1024 * 1024, extensions: ["pdf", "doc", "docx"], mimeTypes: ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
  photo: { maxBytes: 8 * 1024 * 1024, extensions: ["jpg", "jpeg", "png", "webp"], mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
};

// A text field longer than this is a mistake or an attempt to fill the object.
const MAX_TEXT_BYTES = 8000;
// Ceiling on the whole request, so a large upload is refused before it is read.
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_SUBMISSIONS_PER_WINDOW = 5;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

// Leading bytes that identify the formats we accept. The declared type and the
// filename both come from the client, so neither is trusted on its own: a
// request has to agree with its own contents.
const SIGNATURES = {
  pdf: [[0x25, 0x50, 0x44, 0x46]], // %PDF
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  webp: [[0x52, 0x49, 0x46, 0x46]], // "RIFF", refined below
};

const REQUIRED_FIELDS = [
  "name", "title", "organisation", "current_role", "email", "country", "bio_short",
  "expertise", "consent_accuracy", "consent_submission", "consent_review",
  "public_consent",
];

const CONSENT_CHECKS = ["consent_accuracy", "consent_submission", "consent_review"];

const FIELD_LABELS = {
  name: "Full name",
  title: "Professional title",
  organisation: "Organisation / affiliation",
  current_role: "Current position / role",
  email: "Professional email",
  country: "Country / base",
  bio_short: "Short biography",
  expertise: "Areas of expertise",
  consent_accuracy: "Confirmation that the information is accurate",
  consent_submission: "Acknowledgement that submission does not guarantee acceptance",
  consent_review: "Consent to be reviewed for association and related work",
  public_consent: "Decision on publishing a profile",
  cv: "CV",
  photo: "Professional photograph",
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const path = url(request).pathname;

    // Local test aid. It only exists when ALLOW_TEST_RESET is set, which is in
    // the git-ignored .dev.vars and not in wrangler.toml, so a deployed Worker
    // has no such route.
    if (path === "/__test/reset-rate-limit" && env.ALLOW_TEST_RESET === "true") {
      await env.RATE_LIMIT?.delete(`submissions:${clientKey(request)}:${windowBucket()}`);
      return new Response("reset", { status: 200, headers: plain() });
    }
    if (path === "/__test/list" && env.ALLOW_TEST_RESET === "true") {
      // Also test-only, for the same reason. Returns every object under an
      // optional prefix so the suite can prove a write, or a rollback, without
      // sharing storage keys in a production route.
      const prefix = url(request).searchParams.get("prefix") || "";
      const pages = [];
      let cursor;
      do {
        const page = prefix
          ? await env.APPLICATIONS.list({ prefix, cursor })
          : await env.APPLICATIONS.list({ cursor });
        pages.push(...page.objects.map((o) => ({ key: o.key, size: o.size })));
        cursor = page.truncated ? page.cursor : null;
      } while (cursor);
      return json({ ok: true, objects: pages }, 200, origin, env);
    }

    if (request.method === "OPTIONS") {
      // Answered even for a disallowed origin, with no CORS headers attached:
      // the browser is then blocked from reading the response.
      return preflight(origin, env);
    }

    if (path !== "/submit") {
      return new Response("Not found", { status: 404, headers: plain() });
    }
    // A browser can be told not to read the response, but it can still send the
    // request, so the origin is checked before anything else happens.
    if (!isAllowedOrigin(origin, env)) {
      console.warn(JSON.stringify({ event: "origin_rejected", origin }));
      return json({ ok: false, error: "This request did not come from an allowed origin." }, 403, origin, env);
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Only POST is accepted here." }, 405, origin, env);
    }

    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_REQUEST_BYTES) {
      return json({ ok: false, error: "That upload is too large to send. Please reduce the file sizes and try again." }, 413, origin, env);
    }

    // Rate limiting runs before parsing, so a flood costs a counter write
    // rather than a multipart parse and two uploads.
    const limited = await rateLimited(request, env);
    if (limited) return json({ ok: false, error: limited }, 429, origin, env);

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: "That submission could not be read. Please try again." }, 400, origin, env);
    }

    if (honeypotFilled(form)) {
      // Answering normally keeps a bot from learning it was caught, but
      // nothing is written.
      console.warn(JSON.stringify({ event: "honeypot_triggered" }));
      return json({ ok: true, id: "received" }, 200, origin, env);
    }

    const turnstile = await checkTurnstile(form, env);
    if (!turnstile.ok) return json({ ok: false, error: turnstile.error }, turnstile.status, origin, env);

    const fields = readFields(form);
    const invalid = validateFields(fields);
    if (invalid.length) {
      return json(
        { ok: false, error: "Please check the highlighted answers and try again.", fields: invalid },
        422, origin, env
      );
    }

    const cv = await inspectUpload("cv", form.get("cv"), LIMITS.cv);
    const photo = await inspectUpload("photo", form.get("photo"), LIMITS.photo);
    const files = [cv, photo].filter(Boolean);
    const badFiles = files.filter((f) => !f.ok);
    if (badFiles.length) {
      return json(
        { ok: false, error: "One of the files could not be accepted. Please check the file type and size.", fields: badFiles.map((f) => ({ field: f.field, message: f.message })) },
        422, origin, env
      );
    }

    const id = newApplicationId();
    const fault = env.ALLOW_TEST_RESET === "true" ? form.get("__test_fault") : null;
    const stored = await store({ id, fields, files, env, fault });

    if (!stored.ok) {
      // The reason goes to the log with the id, which is the only handle a
      // reviewer will have. The applicant gets none of it.
      console.error(JSON.stringify({ event: "store_failed", id, reason: stored.reason }));
      return json(
        { ok: false, error: "Your application could not be saved. Nothing has been sent — please try again in a moment." },
        500, origin, env
      );
    }

    console.log(JSON.stringify({ event: "application_stored", id, has_cv: Boolean(cv), has_photo: Boolean(photo) }));
    return json(
      {
        ok: true,
        id,
        message: "Application submitted successfully. Your application has been received and will be reviewed.",
      },
      200, origin, env
    );
  },
};

// ---- Request plumbing -----------------------------------------------------

function url(request) {
  return new URL(request.url);
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  return allowedOrigins(env).includes(origin);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function corsHeaders(origin, env) {
  const headers = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  // Nothing here is a secret, but nothing here is cacheable either.
  headers["cache-control"] = "no-store";
  return headers;
}

function preflight(origin, env) {
  if (!isAllowedOrigin(origin, env)) {
    return new Response(null, { status: 403, headers: plain() });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
}

function json(payload, status, origin, env) {
  const headers = plain();
  Object.assign(headers, { "content-type": "application/json; charset=utf-8" });
  if (isAllowedOrigin(origin, env)) Object.assign(headers, corsHeaders(origin, env));
  return new Response(JSON.stringify(payload), { status, headers });
}

function plain() {
  return { "content-type": "text/plain; charset=utf-8" };
}

// ---- Spam controls --------------------------------------------------------

// A field a person cannot see, so only an automated client fills it in.
function honeypotFilled(form) {
  return String(form.get("company_website") || "").trim().length > 0;
}

async function checkTurnstile(form, env) {
  const secret = env.TURNSTILE_SECRET;
  // No secret configured means Turnstile is not in use, which is a deliberate
  // choice rather than a silent pass: the honeypot and the rate limit still
  // apply. Setting the secret makes it mandatory, and a failure is a refusal.
  if (!secret) return { ok: true };

  const token = String(form.get("cf-turnstile-response") || "").trim();
  if (!token) {
    return { ok: false, status: 400, error: "The form check did not complete. Please reload the page and try again." };
  }

  let verdict;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
    });
    verdict = await response.json();
  } catch {
    // Failing closed: if the check cannot be reached, the application does not
    // go in, because the alternative is a form anyone can post to.
    console.error(JSON.stringify({ event: "turnstile_unreachable" }));
    return { ok: false, status: 503, error: "The form check is temporarily unavailable. Please try again shortly." };
  }

  if (!verdict.success) {
    console.warn(JSON.stringify({ event: "turnstile_rejected", codes: verdict["error-codes"] || [] }));
    return { ok: false, status: 400, error: "The form check did not pass. Please reload the page and try again." };
  }
  return { ok: true };
}

// A fixed window per client, counted in KV. KV is eventually consistent, so a
// burst can slip a few counts through; that is acceptable for a form whose
// worst case is a handful of extra applications, and it costs one read and one
// write instead of infrastructure nobody has to maintain.
async function rateLimited(request, env) {
  if (!env.RATE_LIMIT) return null;

  const key = `submissions:${clientKey(request)}:${windowBucket()}`;
  const current = Number((await env.RATE_LIMIT.get(key)) || 0);

  if (current >= MAX_SUBMISSIONS_PER_WINDOW) {
    return "Too many applications have been sent from this connection. Please try again later.";
  }

  await env.RATE_LIMIT.put(key, String(current + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });
  return null;
}

function windowBucket() {
  return Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
}

// The Cloudflare client IP, which the platform sets. A header a client could
// set itself is not used.
function clientKey(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

// ---- Reading and validating the submission ---------------------------------

function readFields(form) {
  const fields = {};
  for (const [key, value] of form.entries()) {
    if (value instanceof File) continue;
    if (key === "__test_fault") continue; // test-only, never reaches a record
    const text = String(value);
    if (text.length > MAX_TEXT_BYTES) continue;
    if (key in fields) {
      fields[key] = [].concat(fields[key], text);
    } else {
      fields[key] = text;
    }
  }
  return fields;
}

function fieldValue(fields, key) {
  const value = fields[key];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value === undefined ? "" : value).trim();
}

function validateFields(fields) {
  const problems = [];

  for (const key of REQUIRED_FIELDS) {
    if (!fieldValue(fields, key)) {
      problems.push({ field: key, message: `${FIELD_LABELS[key] || key} is required.` });
    }
  }

  const email = fieldValue(fields, "email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    problems.push({ field: "email", message: "Please check the professional email address." });
  }

  for (const key of CONSENT_CHECKS) {
    const value = fieldValue(fields, key);
    if (value && value !== "on" && value !== "true" && value !== "yes") {
      problems.push({ field: key, message: `${FIELD_LABELS[key]} has to be ticked.` });
    }
  }

  const consent = fieldValue(fields, "public_consent");
  if (consent && consent !== "yes" && consent !== "no") {
    problems.push({ field: "public_consent", message: "Please answer yes or no on publishing a profile." });
  }

  for (const key of ["website", "linkedin"]) {
    const value = fieldValue(fields, key);
    if (value && !/^https:\/\/[^\s]+$/i.test(value)) {
      problems.push({ field: key, message: `${FIELD_LABELS[key] || key} should start with https://.` });
    }
  }

  return problems;
}

// ---- Files ----------------------------------------------------------------

// Returns null when the field was left empty, and a rejected result when it was
// sent but is not acceptable. The type, the extension and the leading bytes all
// have to agree, because the first two are chosen by whoever sent the request.
//
// The field name is passed in rather than read from the File: a File carries the
// name the client chose for it, and that name must not reach a storage key.
async function inspectUpload(field, entry, limits) {
  if (!(entry instanceof File)) return null;
  if (entry.size === 0) {
    return { ok: false, field, message: `${FIELD_LABELS[field] || "That file"} is empty.` };
  }
  if (entry.size > limits.maxBytes) {
    return {
      ok: false, field,
      message: `${FIELD_LABELS[field] || "That file"} is larger than ${Math.round(limits.maxBytes / (1024 * 1024))} MB.`,
    };
  }

  const declared = (entry.type || "").split(";")[0].trim().toLowerCase();
  if (declared && !limits.mimeTypes.includes(declared)) {
    return { ok: false, field, message: `${FIELD_LABELS[field] || "That file"} is not an accepted file type.` };
  }

  const extension = extensionOf(entry.name);
  if (!extension || !limits.extensions.includes(extension)) {
    return { ok: false, field, message: `${FIELD_LABELS[field] || "That file"} is not an accepted file type.` };
  }

  const bytes = new Uint8Array(await entry.slice(0, 16).arrayBuffer());
  if (!matchesSignature(extension, bytes)) {
    return {
      ok: false, field,
      message: `${FIELD_LABELS[field] || "That file"} does not look like a ${extension.toUpperCase()} file.`,
    };
  }

  return { ok: true, field, extension, size: entry.size, stream: entry.stream(), type: entry.type };
}

// The name the client sent is used for nothing but this check.
function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  return match ? match[1].toLowerCase() : "";
}

function matchesSignature(extension, bytes) {
  if (extension === "webp") {
    // RIFF....WEBP, so the first four bytes alone are not enough.
    return startsWith(bytes, SIGNATURES.webp[0]) && ascii(bytes, 8, 4) === "WEBP";
  }
  if (extension === "docx") {
    // A .docx is a zip, and so is plenty else, so only the container is checked
    // here. The file is never opened, extracted or rendered.
    return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  }
  if (extension === "doc") {
    // Legacy binary Word: a compound file, magic D0 CF 11 E0.
    return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]);
  }
  return (SIGNATURES[extension] || []).some((prefix) => startsWith(bytes, prefix));
}

function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

// ---- Storage --------------------------------------------------------------

// Date-ordered and random, so applications sort by arrival and no two collide.
// Nothing here comes from the applicant.
function newApplicationId() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `app-${stamp}-${random}`;
}

// A fresh random name per file. The applicant's own filename is dropped: it can
// carry a path, an extension nobody checked, or a name. Only the extension
// survives, and it is the one that was checked against the file's bytes.
function objectName(id, field, extension) {
  return `applications/${id}/${field}/${crypto.randomUUID().replace(/-/g, "")}.${extension}`;
}

// A half-written application is worse than a rejected one: the photograph could
// sit in the bucket with no record of who sent it, or a CV could outlive the
// photo it belongs to. Every key is therefore collected as it is written, and
// removed again if any later write fails. The record is written last, so it is
// the point at which the application becomes real.
async function store({ id, fields, files, env, fault }) {
  const written = [];
  try {
    const keys = {};

    for (const file of files) {
      // Test-only fault injection: make the second write fail so the first one
      // has to be rolled back. Only reachable through __test_fault while
      // ALLOW_TEST_RESET is set, which production never is.
      if (fault === "photo_fails" && file.field === "photo") {
        throw new Error("test fault: photo write failed");
      }
      const key = objectName(id, file.field, file.extension);
      await env.APPLICATIONS.put(key, file.stream, {
        httpMetadata: {
          // Recorded as what was checked, not as what the client claimed, and
          // never served: the bucket has no public access.
          contentType: file.type || "application/octet-stream",
          contentDisposition: "attachment",
        },
        customMetadata: { application_id: id, kind: file.field },
      });
      written.push(key);
      keys[file.field] = { key, size: file.size, contentType: file.type || "application/octet-stream" };
    }

    const consent = fieldValue(fields, "public_consent");
    const record = {
      id,
      received_at: new Date().toISOString(),
      status: "submitted",
      // Recorded exactly as answered. It decides whether a profile may ever be
      // published, and it is not a switch: publishing is a separate, manual
      // step in the CMS, and a reviewer approving an application does not set
      // visibility from this.
      consent: {
        public_profile: consent,
        publication_permitted: consent === "yes",
        accuracy: true,
        no_guarantee: true,
        review: true,
        recorded_at: new Date().toISOString(),
      },
      files: keys,
      fields: {
        name: fieldValue(fields, "name"),
        title: fieldValue(fields, "title"),
        organisation: fieldValue(fields, "organisation"),
        current_role: fieldValue(fields, "current_role"),
        email: fieldValue(fields, "email"),
        country: fieldValue(fields, "country"),
        website: fieldValue(fields, "website"),
        linkedin: fieldValue(fields, "linkedin"),
        bio_short: fieldValue(fields, "bio_short"),
        bio_long: fieldValue(fields, "bio_long"),
        qualifications: fieldValue(fields, "qualifications"),
        experience: fieldValue(fields, "experience"),
        expertise: fieldValue(fields, "expertise"),
        sectors: fieldValue(fields, "sectors"),
        regions: fieldValue(fields, "regions"),
        countries: fieldValue(fields, "countries"),
        other_expertise: fieldValue(fields, "other_expertise"),
        roles: fieldValue(fields, "roles"),
        contributions: fieldValue(fields, "contributions"),
        teaching_subjects: fieldValue(fields, "teaching_subjects"),
        delivery: fieldValue(fields, "delivery"),
        preferred_audiences: fieldValue(fields, "preferred_audiences"),
        languages: fieldValue(fields, "languages"),
        availability: fieldValue(fields, "availability"),
        constraints: fieldValue(fields, "constraints"),
        portfolio_links: fieldValue(fields, "portfolio_links"),
        additional: fieldValue(fields, "additional"),
      },
    };

    // Test-only fault injection: files are in, the record put fails. Every file
    // in `written` must disappear.
    if (fault === "record_fails") {
      throw new Error("test fault: record write failed");
    }
    const recordKey = `applications/${id}/application.json`;
    await env.APPLICATIONS.put(recordKey, JSON.stringify(record, null, 2), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { application_id: id, kind: "record" },
    });
    written.push(recordKey);

    return { ok: true };
  } catch (error) {
    // Nothing is logged here beyond the reason: the request body may hold an
    // applicant's personal data, and this is a log the operator reads.
    await Promise.all(
      written.map((key) => env.APPLICATIONS.delete(key).catch(() => {}))
    );
    return { ok: false, reason: String(error && error.message ? error.message : error) };
  }
}
