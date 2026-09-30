/**
 * Small HTML helpers shared by the review pages.
 *
 * Everything an applicant typed is printed back to a reviewer, so every value
 * that reaches a page goes through `escape()` first. An application is
 * untrusted input by definition: a name like
 * `<img src=x onerror=alert(1)>` is stored verbatim by the submissions Worker
 * and has to stay inert here.
 */

/** Escape a value for use in element text or a quoted attribute value. */
export function escape(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character];
  });
}

/**
 * Serialise for embedding inside a <script> block. Escaping "<" is what stops a
 * "</script>" inside a value from closing the tag early.
 */
export function jsonScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** A value as text, with a fallback for anything empty. */
export function orDash(value, fallback = "—") {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text === "" ? fallback : escape(text);
}

/** Join a list into readable text, keeping any list order the applicant chose. */
export function listText(value) {
  if (value === null || value === undefined) return "";
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => String(item).trim())
    .filter(Boolean)
    .join(", ");
}

/** Render a list of terms as labelled tags, or a single dash when empty. */
export function tagList(value) {
  const items = (Array.isArray(value) ? value : [value])
    .map((item) => String(item).trim())
    .filter(Boolean);

  if (!items.length) return '<p class="rv-empty">Not given</p>';
  return `<ul class="rv-tags">${items
    .map((item) => `<li class="rv-tag">${escape(item)}</li>`)
    .join("")}</ul>`;
}

/** Long free text, split into paragraphs so a wall of text stays readable. */
export function paragraphs(value) {
  const text = value === null || value === undefined ? "" : String(value).trim();
  if (!text) return '<p class="rv-empty">Not given</p>';
  return text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => `<p>${escape(chunk).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** A definition-list row, skipped when there is nothing to show. */
export function row(label, value, extraClass = "") {
  return `<div class="rv-row${extraClass ? " " + escape(extraClass) : ""}">
      <dt>${escape(label)}</dt>
      <dd>${value}</dd>
    </div>`;
}

/** Format an ISO timestamp for a reader, without inventing a locale. */
export function timestamp(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escape(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** Format a byte count for display. */
export function bytes(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
