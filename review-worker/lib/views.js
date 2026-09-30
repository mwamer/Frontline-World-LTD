/**
 * The reviewer's pages.
 *
 * Three of them: the sign-in page, the application list, and one application.
 * They are HTML in this Worker rather than pages in the Hugo site, because a
 * page in the site would be public. The dashboard has to be behind the
 * authentication in the Worker, with no static copy of an application anywhere
 * a visitor could reach it.
 *
 * Every applicant-supplied value passes through `escape()` on the way out. That
 * is not a formality: the review page is the one place untrusted text is
 * rendered as HTML, and an applicant's name or biography is arbitrary input.
 */

import { escape, orDash, listText, tagList, paragraphs, row, timestamp, bytes } from "./html.js";
import { STATUSES, statusLabel } from "./store.js";
import { RETENTION_DAYS, addDays } from "./retention.js";

/** Consent, stated the way the reviewer has to read it. */
function consentBlock(application) {
  const consent = application?.consent || {};
  const permitted = consent.publication_permitted;

  if (permitted === true) {
    return `<div class="rv-consent rv-consent-yes">
        <p class="rv-consent-answer">Public profile consent: <strong>YES</strong></p>
        <p class="rv-consent-note">The applicant agreed to have a profile published. A
        reviewer may still choose to keep the record private; consent permits
        publication, it does not require it.</p>
      </div>`;
  }

  if (permitted === false) {
    return `<div class="rv-consent rv-consent-no">
        <p class="rv-consent-answer">Public profile consent: <strong>NO</strong></p>
        <p class="rv-consent-note">The applicant did <strong>not</strong> agree to a published
        profile. The record may be created and the person may be approved, but
        the publication gate will refuse to publish them: setting
        <code>visibility: public</code> on this record will not put them on the
        site. This is enforced by the site build, not by this page.</p>
      </div>`;
  }

  return `<div class="rv-consent rv-consent-unknown">
      <p class="rv-consent-answer">Public profile consent: <strong>NOT RECORDED</strong></p>
      <p class="rv-consent-note">This application predates the consent record, so there is
      nothing to enforce. Check the original application with the person before
      publishing anything, and treat publication as not permitted until they
      confirm it.</p>
    </div>`;
}

/**
 * The three states a reviewer needs to see, stated separately.
 *
 * Application status, consent and publication are different things, and
 * collapsing them is how a record ends up on the website by accident. The panel
 * puts all three on the page at once, so the combination is always visible:
 * an application can be Approved while its Associate is Private, and that is a
 * normal state rather than a contradiction.
 */
function stateBlock(review, record, permitted) {
  const visibility = record.ok ? record.visibility : null;
  const status = record.ok ? record.profileStatus : null;

  const consentText = permitted === true ? "Yes" : permitted === false ? "No" : "Not recorded";

  return `<dl class="rv-state">
      <div class="rv-state-row">
        <dt class="rv-state-key">Application</dt>
        <dd class="rv-state-value">${escape(statusLabel(review.status))}</dd>
      </div>
      <div class="rv-state-row">
        <dt class="rv-state-key">Consent</dt>
        <dd class="rv-state-value">${escape(consentText)}</dd>
      </div>
      <div class="rv-state-row">
        <dt class="rv-state-key">Profile</dt>
        <dd class="rv-state-value">${escape(visibility || (review.associate_id ? "unknown" : "Not created"))}</dd>
      </div>
      <div class="rv-state-row">
        <dt class="rv-state-key">Status</dt>
        <dd class="rv-state-value">${escape(status || "—")}</dd>
      </div>
    </dl>`;
}

/** One hidden CSRF field. Every form on this page carries one. */
function csrfField(token) {
  return `<input type="hidden" name="csrf" value="${escape(token)}">`;
}

/** The list, with the filters a reviewer actually uses. */
export function listPage(rows, { login, filter, flash, token, retention }) {
  const counts = new Map([["all", rows.length]]);
  for (const row_ of rows) counts.set(row_.status, (counts.get(row_.status) || 0) + 1);

  const tabs = [["all", "All"], ...STATUSES.map((status) => [status, statusLabel(status)])]
    .map(([value, label]) => {
      const active = filter === value;
      const count = counts.get(value) || 0;
      return `<a class="rv-tab${active ? " is-active" : ""}" href="?status=${encodeURIComponent(value)}">
          ${escape(label)} <span class="rv-tab-count">${count}</span>
        </a>`;
    })
    .join("");

  const visible = filter === "all" || filter === "" ? rows : rows.filter((row_) => row_.status === filter);

  const body = visible.length
    ? visible.map(listRow).join("")
    : `<p class="rv-empty rv-empty-block">No application has this status.</p>`;

  return layout({
    title: "Applications",
    login,
    token,
    body: `
      <header class="rv-header">
        <div>
          <h1 class="rv-title">Applications</h1>
          <p class="rv-subtitle">Newest first. An application is never published by
          being approved.</p>
        </div>
      </header>
      ${flash ? `<p class="rv-flash">${escape(flash)}</p>` : ""}
      ${retentionBanner(retention)}
      <nav class="rv-tabs" aria-label="Filter by status">${tabs}</nav>
      <div class="rv-list">${body}</div>`,
  });
}

function listRow(row) {
  const consent = row.consent;
  const consentLabel =
    consent?.publication_permitted === true
      ? '<span class="rv-pill rv-pill-yes">Consent: yes</span>'
      : consent?.publication_permitted === false
        ? '<span class="rv-pill rv-pill-no">Consent: no</span>'
        : '<span class="rv-pill rv-pill-unknown">Consent: not recorded</span>';

  const name = row.unreadable
    ? `<span class="rv-name">Record unreadable</span>`
    : `<span class="rv-name">${escape(row.name || "No name given")}</span>`;

  const associated = row.review?.associate_id
    ? `<span class="rv-pill rv-pill-linked">Associate: ${escape(row.review.associate_id)}</span>`
    : "";

  return `<a class="rv-row-card" href="/application/${encodeURIComponent(row.id)}">
      <div class="rv-row-main">
        ${name}
        <span class="rv-row-meta">${orDash(row.title)} &middot; ${orDash(row.organisation)}</span>
      </div>
      <div class="rv-row-side">
        <span class="rv-pill rv-status rv-status-${escape(row.status)}">${escape(statusLabel(row.status))}</span>
        ${consentLabel}
        ${associated}
        <span class="rv-row-id">${escape(row.id)}</span>
        <span class="rv-row-date">${escape(timestamp(row.received_at))}</span>
      </div>
    </a>`;
}

/**
 * One application, in the sections a reviewer works through.
 *
 * `record` is what the repository holds, read at request time. The publication
 * panel is built from it rather than from the review's own account of the last
 * action, so a record edited in the CMS shows its real state here and the
 * buttons offer the change that is actually available.
 */
export function reviewPage(application, review, { login, flash, token, record }) {
  const id = application.id;
  const fields = application.fields || {};
  const permitted = application?.consent?.publication_permitted;

  const fileCard = (kind, label) => {
    const file = application.files?.[kind];
    if (!file) return `<div class="rv-file rv-file-missing"><span class="rv-file-label">${escape(label)}</span><span class="rv-file-note">Not uploaded</span></div>`;
    return `<div class="rv-file">
        <span class="rv-file-label">${escape(label)}</span>
        <span class="rv-file-note">${escape(bytes(file.size))} &middot; ${escape(file.contentType || "unknown type")}</span>
        <span class="rv-file-actions">
          <a class="rv-btn rv-btn-small" href="/file/${encodeURIComponent(id)}?kind=${kind}&amp;disposition=inline">View</a>
          <a class="rv-btn rv-btn-small" href="/file/${encodeURIComponent(id)}?kind=${kind}&amp;disposition=attachment">Download</a>
        </span>
      </div>`;
  };

  return layout({
    title: `Application ${id}`,
    login,
    token,
    body: `
      <header class="rv-header">
        <div>
          <p class="rv-breadcrumb"><a href="/">Applications</a></p>
          <h1 class="rv-title">${escape(fields.name || "Unnamed application")}</h1>
          <p class="rv-subtitle">${orDash(fields.title)} &middot; ${orDash(fields.organisation)}</p>
          <p class="rv-subtitle rv-subtitle-small">${escape(id)} &middot; received ${escape(timestamp(application.received_at))}</p>
        </div>
        <span class="rv-pill rv-status rv-status-${escape(review.status)}">${escape(statusLabel(review.status))}</span>
      </header>
      ${flash ? `<p class="rv-flash">${escape(flash)}</p>` : ""}
      ${consentBlock(application)}

      <div class="rv-body">
        <div class="rv-main">
          <section class="rv-section">
            <h2 class="rv-section-title">Basic information</h2>
            <dl class="rv-grid">
              ${row("Name", orDash(fields.name))}
              ${row("Professional title", orDash(fields.title))}
              ${row("Organisation", orDash(fields.organisation))}
              ${row("Current position", orDash(fields.current_role))}
              ${row("Country / base", orDash(fields.country))}
              ${row("Website", orDash(fields.website))}
              ${row("LinkedIn", orDash(fields.linkedin))}
              ${row("Professional email", orDash(fields.email))}
            </dl>
          </section>

          <section class="rv-section">
            <h2 class="rv-section-title">Professional profile</h2>
            <dl class="rv-grid">
              ${row("Biography", paragraphs(fields.bio_long))}
              ${row("Qualifications", tagList(toArray(fields.qualifications)))}
              ${row("Selected experience", tagList(toArray(fields.experience)))}
            </dl>
          </section>

          <section class="rv-section">
            <h2 class="rv-section-title">Expertise</h2>
            <dl class="rv-grid">
              ${row("Primary expertise", tagList(toArray(fields.expertise)))}
              ${row("Sectors", tagList(toArray(fields.sectors)))}
              ${row("Regions", tagList(toArray(fields.regions)))}
              ${row("Countries of expertise", tagList(toArray(fields.countries)))}
              ${row("Other expertise", paragraphs(fields.other_expertise))}
            </dl>
          </section>

          <section class="rv-section">
            <h2 class="rv-section-title">Roles and contributions</h2>
            <dl class="rv-grid">
              ${row("Potential roles", tagList(toArray(fields.roles)))}
              ${row("Contribution areas", tagList(toArray(fields.contributions)))}
            </dl>
          </section>

          <section class="rv-section">
            <h2 class="rv-section-title">Teaching and training</h2>
            <dl class="rv-grid">
              ${row("Topics", tagList(toArray(fields.teaching_subjects)))}
              ${row("Delivery preferences", tagList(toArray(fields.delivery)))}
              ${row("Preferred audiences", tagList(toArray(fields.preferred_audiences)))}
              ${row("Languages", tagList(toArray(fields.languages)))}
            </dl>
          </section>

          <section class="rv-section">
            <h2 class="rv-section-title">Availability</h2>
            <dl class="rv-grid">
              ${row("Availability", tagList(toArray(fields.availability)))}
              ${row("Constraints", paragraphs(fields.constraints))}
            </dl>
          </section>

          <section class="rv-section">
            <h2 class="rv-section-title">Supporting information</h2>
            <dl class="rv-grid">
              ${row("Publications and portfolio", paragraphs(fields.portfolio_links))}
              ${row("Additional information", paragraphs(fields.additional))}
            </dl>
          </section>

          <section class="rv-section">
            <h2 class="rv-section-title">Short biography</h2>
            <p class="rv-note">What the directory card would carry.</p>
            ${paragraphs(fields.bio_short)}
          </section>

          <section class="rv-section">
            <h2 class="rv-section-title">Supporting files</h2>
            <p class="rv-note">Held in the private bucket. These links work only for a
            signed-in reviewer, and are not permanent.</p>
            <div class="rv-files">
              ${fileCard("cv", "CV")}
              ${fileCard("photo", "Photograph")}
            </div>
          </section>

          <section class="rv-section">
            <h2 class="rv-section-title">Review history</h2>
            ${historyBlock(review)}
            <h3 class="rv-subsection-title">Internal notes</h3>
            <p class="rv-note">Notes are for reviewers. They are never shown to the
            applicant and never reach the public site: they are stored in the
            private bucket, not in the associate record.</p>
            ${notesBlock(review)}
            <form class="rv-form" method="post" action="/application/${encodeURIComponent(id)}/note">
              <label class="rv-label" for="note">Add an internal note</label>
              <textarea class="rv-textarea" id="note" name="note" rows="4" required></textarea>
              ${csrfField(token)}
              <button class="rv-btn rv-btn-primary" type="submit">Save note</button>
            </form>
          </section>

          ${associateSection(id, review, record)}
        </div>

        <aside class="rv-side">
          ${approvePanel(id, review, token)}
          ${publicationPanel(id, review, record, permitted, token)}
          ${photographPanel(id, review, record, application, permitted, token)}
          ${actionsForm(id, review, token)}
          ${retentionPanel(id, review)}
        </aside>
      </div>`,
  });
}

function historyBlock(review) {
  const history = review.history || [];
  if (!history.length) return '<p class="rv-empty">No history recorded.</p>';

  return `<ol class="rv-history">${history
    .map((entry) => `<li class="rv-history-item">
        <span class="rv-history-action">${escape(entry.action)}</span>
        <span class="rv-history-meta">${escape(timestamp(entry.at))} by ${escape(entry.reviewer || "unknown")}</span>
        ${entry.note ? `<span class="rv-history-note">${escape(entry.note)}</span>` : ""}
      </li>`)
    .join("")}</ol>`;
}

function notesBlock(review) {
  const notes = review.notes || [];
  if (!notes.length) return '<p class="rv-empty">No internal notes yet.</p>';

  return `<ul class="rv-notes">${notes
    .map((note) => `<li class="rv-note-item">
        <span class="rv-note-text">${escape(note.text)}</span>
        <span class="rv-note-meta">${escape(timestamp(note.at))} by ${escape(note.reviewer || "unknown")}</span>
      </li>`)
    .join("")}</ul>`;
}

/**
 * The decision buttons.
 *
 * Every action is a POST to this Worker, and every POST is checked against the
 * session and a CSRF token again. There is no endpoint that changes a status
 * without one.
 *
 * `approved` is deliberately absent from the select. It is set by Approve &
 * Create Associate, in the same action that creates the record, so that the
 * two can never be true apart.
 */
/**
 * The state of the last retention sweep.
 *
 * A failed deletion is the one thing on this page that needs a person, so it is
 * shown at the top with the ids that could not be removed, rather than buried in
 * a report nobody opens. An application still present after its period is
 * reported as a failure by the sweep, never as a success, and this is where that
 * becomes visible.
 */
function retentionBanner(retention) {
  if (!retention) {
    return `<p class="rv-note">The retention sweep has not run yet. It runs daily at 04:17 UTC.</p>`;
  }
  if (retention.unreadable) {
    return `<p class="rv-warning">The last retention report could not be read. Check the bucket.</p>`;
  }

  const failed = retention.failures || [];
  if (failed.length) {
    return `<section class="rv-warning">
        <p><strong>Retention: ${failed.length} could not be completed.</strong>
        These applications are past their period but were not removed. They are
        listed in the report at <code>retention/last-run.json</code>.</p>
        <ul class="rv-history">${failed.slice(0, 10).map((failure) => `<li class="rv-history-item">
            <span class="rv-history-action">${escape(failure.id || "(listing)")}</span>
            <span class="rv-history-meta">${escape([failure.stage, failure.error].filter(Boolean).join(" — "))}</span>
          </li>`).join("")}</ul>
        ${failed.length > 10 ? `<p class="rv-note">and ${failed.length - 10} more</p>` : ""}
      </section>`;
  }

  return `<p class="rv-note">Retention sweep last ran ${escape(String(retention.at || "unknown"))}:
    ${retention.scanned || 0} scanned, ${retention.deleted || 0} deleted,
    ${retention.uploadsDiscarded || 0} upload set${retention.uploadsDiscarded === 1 ? "" : "s"} removed,
    ${retention.needsReview || 0} awaiting a decision.
    ${retention.dryRun ? "<strong>This was a dry run: nothing was deleted.</strong>" : ""}</p>`;
}

function actionsForm(id, review, token) {
  const options = STATUSES.filter((status) => status !== "approved")
    .map((status) => {
      const selected = status === review.status ? " selected" : "";
      const disabled = status === review.status ? " disabled" : "";
      return `<option value="${escape(status)}"${selected}${disabled}>${escape(statusLabel(status))}</option>`;
    })
    .join("");

  return `<form class="rv-panel rv-form" method="post" action="/application/${encodeURIComponent(id)}/status">
      <h2 class="rv-panel-title">Status</h2>
      <p class="rv-note">Current: <strong>${escape(statusLabel(review.status))}</strong></p>
      <label class="rv-label" for="status">Move to</label>
      <select class="rv-select" id="status" name="status">${options}</select>
      <label class="rv-label" for="status_note">Reviewer note</label>
      <textarea class="rv-textarea" id="status_note" name="note" rows="3"
        placeholder="Why this decision, for the next reviewer"></textarea>
      <p class="rv-note">Required for a withdrawal, and worth writing for a
      rejection: it is what the retention sweep reads, and a decision with no
      recorded reason is one nobody can account for later.</p>

      <h3 class="rv-subhead">Hold deletion</h3>
      <p class="rv-note">Rejected applications are deleted after 12 months and
      withdrawn ones after 30 days. Setting both fields below holds deletion past
      that date. Clearing both releases the hold.</p>
      <label class="rv-label" for="retain_until">Retain until <span class="rv-optional">date</span></label>
      <input class="rv-input" type="date" id="retain_until" name="retain_until" value="${escape(String(review.retention_hold_until || "").slice(0, 10))}">
      <label class="rv-label" for="retain_reason">Reason for the hold <span class="rv-optional">required with the date</span></label>
      <input class="rv-input" type="text" id="retain_reason" name="retain_reason"
        value="${escape(review.retention_hold_reason || "")}"
        placeholder="Why this needs to be kept longer">
      ${csrfField(token)}
      <button class="rv-btn rv-btn-primary" type="submit">Save status</button>
      <p class="rv-note">Nothing is emailed to the applicant: there is no applicant account
      and no mail step in this pipeline.</p>
      ${review.status === "approved"
        ? `<p class="rv-note">Approved is not in this list: it is set by Approve &amp; Create Associate.</p>`
        : ""}
    </form>`;
}

/**
 * What the retention sweep will do to this application, and when.
 *
 * Shown on the application page rather than only in the sweep's report, because
 * "when will this be deleted" is the question a reviewer asks while deciding
 * something, not a week later from a report.
 */
function retentionPanel(id, review) {
  // The stamp and the period are named per status rather than looked up by
  // status, because the two do not have the same key: an approved application
  // is reviewed after `approvedReviewAfter`, not after a period called
  // "approved". Indexing the period by status is the mistake that took this
  // page down once already.
  const ended = {
    rejected: { label: "Rejected", stamp: review.rejected_at, period: RETENTION_DAYS.rejected },
    withdrawn: { label: "Withdrawn", stamp: review.withdrawn_at, period: RETENTION_DAYS.withdrawn },
    approved: { label: "Approved", stamp: review.approved_at, period: RETENTION_DAYS.approvedReviewAfter },
  }[review.status];

  const deleteAfter = ended && ended.stamp ? addDays(ended.stamp, ended.period) : null;
  const due = review.status === "approved" ? "never automatically" : "—";

  return `<section class="rv-panel">
      <h2 class="rv-panel-title">Retention</h2>
      <dl class="rv-state">
        <dt>Status</dt>
        <dd class="rv-state-value">${escape(statusLabel(review.status))}</dd>
        <dt>Decision recorded</dt>
        <dd class="rv-state-value">${ended && ended.stamp ? escape(ended.stamp) : "—"}</dd>
        <dt>Scheduled for deletion</dt>
        <dd class="rv-state-value">${deleteAfter ? escape(deleteAfter) : due}</dd>
        ${review.retention_hold_until
          ? `<dt>On hold until</dt>
             <dd class="rv-state-value">${escape(review.retention_hold_until)} &middot; ${escape(review.retention_hold_reason || "")}</dd>`
          : ""}
        ${review.uploads_discarded_at
          ? `<dt>Uploads removed</dt>
             <dd class="rv-state-value">${escape(review.uploads_discarded_at)}</dd>`
          : ""}
      </dl>
      <p class="rv-note">The sweep runs daily at 04:17 UTC and only acts once a
      period has passed. An approved application is never deleted automatically.</p>
    </section>`;
}

/**
 * Approve, and create the record.
 *
 * One button, because the two are one event. Everything it needs is decided on
 * the server: the fields come from the application in R2, the terms are checked
 * against the repository's own vocabulary, and the record is created private and
 * inactive. Approving twice does nothing the second time.
 */
function approvePanel(id, review, token) {
  if (review.associate_id) {
    return `<div class="rv-panel rv-panel-good">
        <h2 class="rv-panel-title">Associate</h2>
        <p class="rv-note">Created as <code>${escape(review.associate_id)}</code> on
        ${escape(timestamp(review.associate_created_at))} by
        ${escape(review.associate_created_by || "unknown")}.</p>
        <p class="rv-note"><code>data/associates/${escape(review.associate_id)}.yml</code></p>
        <p class="rv-note">Approving again would change nothing, so there is
        nothing to do here. Publication is the decision below.</p>
      </div>`;
  }

  return `<form class="rv-panel rv-form" method="post" action="/application/${encodeURIComponent(id)}/approve">
      <h2 class="rv-panel-title">Approve &amp; Create Associate</h2>
      <p class="rv-note">Creates <code>data/associates/&lt;name&gt;.yml</code> from
      this application, with the applicant's id on the record and the consent
      answer copied from the application in storage.</p>
      <p class="rv-note">The record is created <strong>private</strong> and
      <strong>inactive</strong>. Nobody is published by approving, and the
      photograph is not copied anywhere.</p>
      <label class="rv-label" for="approve_note">Note for the history <span class="rv-optional">optional</span></label>
      <textarea class="rv-textarea" id="approve_note" name="note" rows="2"
        placeholder="Anything the next reviewer should know"></textarea>
      ${csrfField(token)}
      <button class="rv-btn rv-btn-primary" type="submit">Approve &amp; Create Associate</button>
    </form>`;
}

/**
 * Publication, decided separately from approval.
 *
 * The consent shown here is the applicant's own answer, read from the
 * application record. When it is not yes, no Public button is rendered at all —
 * and the server refuses the request if one is sent anyway, which is the part
 * that actually matters. A missing control is a hint; the refusal is the rule.
 */
function publicationPanel(id, review, record, permitted, token) {
  const head = `<h2 class="rv-panel-title">Publication</h2>${stateBlock(review, record, permitted)}`;

  if (!review.associate_id) {
    return `<div class="rv-panel">
        ${head}
        <p class="rv-note">No Associate record has been created yet. Approve the
        application first: publication is a decision about a record that exists.</p>
      </div>`;
  }

  if (permitted !== true) {
    const why =
      permitted === false
        ? "The applicant did not consent to a public profile, so this person cannot be published and the record stays private. The server refuses a publication request for this application whatever the record or the site build say."
        : "This application records no consent answer, so publication is treated as not permitted until it is established otherwise.";

    // Consent refuses one direction only. If the record is nonetheless exposed —
    // a CMS edit, an older dashboard, a hand change in the repository — the only
    // action that matters is taking it down, and it stays available without
    // consent because it cannot publish anybody.
    const exposed =
      !record.unreadable && !record.missing && record.visibility === "public" && record.profileStatus === "active";

    return `<div class="rv-panel rv-panel-locked">
        ${head}
        <p class="rv-note rv-note-strong">Public publication is not permitted by the applicant.</p>
        <p class="rv-note">${escape(why)}</p>
        ${exposed
          ? `<p class="rv-warning">The record is public and active even so. Make it private
             to take the profile off the site.</p>
             <div class="rv-actions">
               <form method="post" action="/application/${encodeURIComponent(id)}/publication">
                 ${csrfField(token)}
                 <input type="hidden" name="action" value="private">
                 <button class="rv-btn rv-btn-primary" type="submit">Make Private</button>
               </form>
             </div>`
          : ""}
      </div>`;
  }

  if (record.unreadable) {
    return `<div class="rv-panel rv-panel-locked">
        ${head}
        <p class="rv-warning">The Associate record could not be read from the
        repository, so its current state is unknown and nothing was changed.
        ${escape(record.reason || "")}</p>
      </div>`;
  }

  if (record.missing) {
    return `<div class="rv-panel rv-panel-locked">
        ${head}
        <p class="rv-warning">This application is linked to
        <code>${escape(record.path || "")}</code>, but that file is not in the
        repository. Nothing was changed.</p>
      </div>`;
  }

  const isPublic = record.visibility === "public" && record.profileStatus === "active";
  const form = (action, label, primary) => `<form method="post" action="/application/${encodeURIComponent(id)}/publication">
      ${csrfField(token)}
      <input type="hidden" name="action" value="${escape(action)}">
      <button class="rv-btn ${primary ? "rv-btn-primary" : ""}" type="submit"
        ${isPublic === (action === "public") ? "disabled" : ""}>${escape(label)}</button>
    </form>`;

  return `<div class="rv-panel ${isPublic ? "rv-panel-good" : ""}">
      ${head}
      <p class="rv-note">Consent is <strong>yes</strong>, so this person may be
      published. The server re-reads the application in storage and checks it
      again on every request: this panel is a shortcut, not the rule.</p>
      <div class="rv-actions">
        ${form("public", "Make Public", !isPublic)}
        ${form("private", "Make Private", isPublic)}
      </div>
      <p class="rv-note">A public profile also needs <code>visibility: public</code>
      and <code>profile_status: active</code>, which this action sets together.</p>
    </div>`;
}

/**
 * The photograph, which is a decision of its own.
 *
 * Offered only when the applicant consented and the record exists, and kept
 * apart from publication: copying someone's picture into a repository that
 * publishes to a website is not a side effect of being accepted.
 */
function photographPanel(id, review, record, application, permitted, token) {
  if (!review.associate_id) return "";
  if (!application.files?.photo) return "";

  if (record.photo) {
    return `<div class="rv-panel">
        <h2 class="rv-panel-title">Photograph</h2>
        <p class="rv-note">Published as <code>${escape(record.photo)}</code>.</p>
        <p class="rv-note">The copy in private storage is unchanged and is still
        reachable only by a signed-in reviewer.</p>
      </div>`;
  }

  if (permitted !== true) {
    return `<div class="rv-panel rv-panel-locked">
        <h2 class="rv-panel-title">Photograph</h2>
        <p class="rv-note">The applicant did not consent to a public profile, so
        their photograph is not published either. It stays in private storage,
        where you can still look at it.</p>
      </div>`;
  }

  return `<form class="rv-panel rv-form" method="post" action="/application/${encodeURIComponent(id)}/photo">
      <h2 class="rv-panel-title">Photograph</h2>
      <p class="rv-note">Copies the applicant's photograph into
      <code>static/images/${escape(review.associate_id)}</code> and points the
      record at it. This is a separate step on purpose: approving someone does
      not publish their picture.</p>
      <p class="rv-note">A profile with no photograph is valid and the site uses a
      placeholder, so you can leave this alone.</p>
      ${csrfField(token)}
      <button class="rv-btn" type="submit">Publish photograph</button>
    </form>`;
}

/**
 * What the record holds, read back from the repository.
 *
 * Shown rather than offered as an editable box, because the record is generated
 * from the application and a reviewer has no part in writing it. The provenance
 * lines are the point of the panel: the application it came from, when, by whom,
 * and the fingerprint of the consent it was built on.
 */
function associateSection(id, review, record) {
  if (!review.associate_id) return "";

  const warning = record.unreadable
    ? `<p class="rv-warning">The record in the repository could not be read, so what follows is this dashboard's own record of the last action.</p>`
    : record.missing
      ? `<p class="rv-warning">The repository has no <code>${escape(record.path || "")}</code> even though this application is linked to a record. Nothing was created or changed to repair that.</p>`
      : "";

  return `<section class="rv-section rv-section-draft">
      <h2 class="rv-section-title">Associate record</h2>
      <p class="rv-note">Created by this dashboard from the application in
      storage. It is a file in the repository like any other, editable through the
      CMS, and the site is built from it.</p>
      ${warning}
      <dl class="rv-grid">
        ${row("File", `<code>${escape(record.path || `data/associates/${review.associate_id}.yml`)}</code>`)}
        ${row("Profile URL", `<code>/people/${escape(review.associate_id)}/</code>`)}
        ${row("From application", `<code>${escape(id)}</code>`)}
        ${row("Created", `${escape(timestamp(review.associate_created_at))} by ${escape(review.associate_created_by || "unknown")}`)}
        ${row("Consent on record", record.ok ? `<code>publication_permitted: ${escape(record.publicationPermitted ?? "—")}</code>` : "—")}
        ${row("Consent fingerprint", `<code>${escape(review.consent_fingerprint || "—")}</code>`)}
        ${row("Photograph", record.photo ? `<code>${escape(record.photo)}</code>` : "Not published — a profile can be published without one")}
      </dl>
      <h3 class="rv-subsection-title">The consent on this record is a copy</h3>
      <p class="rv-note">The record repeats the applicant's answer so it can be
      read on its own, and the site build needs the field to be
      <code>true</code>. It is not the authority: publishing re-reads the
      application from storage and refuses when the answer there is not yes. The
      fingerprint above is a digest of that answer as it stood at approval, so a
      consent that changes afterwards is detected rather than assumed.</p>
    </section>`;
}

/** The sign-in page. Says what this is, so nobody wonders what they opened. */
export function loginPage({ flash }) {
  return layout({
    title: "Sign in",
    login: null,
    body: `
      <div class="rv-login">
        <h1 class="rv-title">Application review</h1>
        <p class="rv-subtitle">This is the reviewer dashboard for associate
        applications. It holds applicant names, CVs and photographs, so it is
        closed to everyone but the accounts on its reviewer list.</p>
        ${flash ? `<p class="rv-flash">${escape(flash)}</p>` : ""}
        <p><a class="rv-btn rv-btn-primary rv-btn-login" href="/auth">Sign in with GitHub</a></p>
        <p class="rv-note">Sign-in uses the same GitHub account as the CMS. Access is
        granted per account, and every request is checked: knowing an application
        id is not enough to read it.</p>
      </div>`,
  });
}

/** A failure that is not a sign-in problem. */
export function errorPage({ login, code, title, message, token }) {
  return layout({
    title,
    login,
    token,
    body: `
      <div class="rv-login">
        <h1 class="rv-title">${escape(title)}</h1>
        <p class="rv-subtitle">${escape(message)}</p>
        <p><a class="rv-btn" href="/">Back to applications</a></p>
      </div>`,
    code,
  });
}

  /**
   * The shared shell.
   *
   * `login` is the session, not the login string: the name on screen is its
   * `.login`, the same property the allowlist, CSRF and reviewer fields use.
   *
   * `no-store` on every response, because a cached application list would put
   * applicant names in a shared cache. The `noindex` header and robots meta are
   * belt and braces for the same reason: this is not a page for a search engine.
   */
function layout({ title, login, body, code = 200, token }) {
  const account = login
    ? `<div class="rv-account">
        <span class="rv-account-name">${escape(login.login)}</span>
        <form method="post" action="/logout">${csrfField(token)}<button class="rv-btn rv-btn-small" type="submit">Sign out</button></form>
      </div>`
    : "";

  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)} &middot; Application review</title>
<link rel="stylesheet" href="/review.css">
</head>
<body>
<header class="rv-bar">
  <span class="rv-bar-brand">Frontline World &middot; Application review</span>
  ${account}
</header>
<main class="rv-main-wrap">
${body}
</main>
</body>
</html>`;

  return new Response(page, {
    status: code,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, private",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    },
  });
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}
