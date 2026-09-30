#!/usr/bin/env bash
# Test matrix for the associate application review dashboard.
#
# Runs against a local `wrangler dev --local` instance, so the R2 binding is the
# real emulation and no applicant data leaves the machine. Every value used here
# is invented.
#
#   ./test.sh [port]
#
# The suite needs applications in the bucket to review, and it seeds its own by
# posting to a local copy of the intake Worker. If the intake Worker is not
# running, the suite says so rather than passing an empty matrix.
#
# The dashboard also writes to the repository, so the suite runs a stand-in for
# the GitHub Contents API (`test-github-stub.js`) and points the Worker at it
# with GITHUB_API_BASE. That stand-in keeps GitHub's real rules — a create onto an
# existing file is 422, a stale sha is 409, a missing path is 404 — so the
# fail-closed and conflict paths are exercised rather than mocked away. The
# repository token is a throwaway string: the stub does not check it, and it
# reaches nothing.
#
#   node test-github-stub.js 8803 &
#   (cd review-worker && GITHUB_API_BASE=http://127.0.0.1:8803 npx wrangler dev --port 8802)
#   ./test.sh
#
# Nothing here writes to the real repository. The stub holds files in memory and
# forgets them when it stops.

set -uo pipefail

PORT="${1:-8802}"
BASE="http://127.0.0.1:${PORT}"
# Where the seeded applications come from. The intake Worker runs on 8801.
INTAKE="${INTAKE_PORT:-8801}/submit"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
head1() { printf '\n\033[1m=== %s ===\n' "$1"; }

ok()   { PASS=$((PASS+1)); printf '  %s  %s\n' "$(green PASS)" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  %s  %s\n' "$(red FAIL)" "$1"; if [ -n "${2:-}" ]; then printf '          %s\n' "$2"; fi; return 0; }

# check <description> <actual> <expected>
check() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "got '$2', expected '$3'"; }

# ---- Fixtures --------------------------------------------------------------

make_png() { printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$1"; }
make_pdf() { printf '%%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$1"; }

make_png "$WORK/photo.png"
make_pdf "$WORK/cv.pdf"

# A reviewer account on ALLOWED_USERS, and one that is not.
REVIEWER="mwamer"
STRANGER="not-a-reviewer"

COOKIE_JAR="$WORK/cookies"
: > "$COOKIE_JAR"

# ---- Helpers ---------------------------------------------------------------

# Seed one application through the real intake Worker. $1 consent yes/no,
# $2 name, $3 organisation. Prints the generated application id.
seed() {
  local consent="$1" name="$2" org="$3" body="$WORK/seed.json"
  # The intake Worker allows a few submissions an hour per connection, and this
  # suite seeds one per test. Clearing the counter first is what the intake
  # Worker's own test route is for; without it every seed after the fifth is
  # refused and the tests that follow fail on a missing application.
  curl -s -o /dev/null -X POST "http://127.0.0.1:${INTAKE%%/*}/__test/reset-rate-limit" \
    -H "Origin: http://localhost:8889"

  curl -s -o "$body" -X POST "http://127.0.0.1:${INTAKE}" \
    -H "Origin: http://localhost:8889" \
    -F "name=$name" \
    -F "title=Senior Lecturer" \
    -F "organisation=$org" \
    -F "current_role=Course Lead" \
    -F "email=applicant@example.com" \
    -F "country=United Kingdom" \
    -F "bio_short=A short biography for testing." \
    -F "bio_long=A longer biography, split across two paragraphs.

The second paragraph exists to prove paragraphs survive." \
    -F "expertise=education-training" \
    -F "sectors=education" \
    -F "regions=united-kingdom" \
    -F "roles=trainer-facilitator" \
    -F "contributions=professional-training" \
    -F "qualifications=PhD Education" \
    -F "experience=Ten years lecturing" \
    -F "teaching_subjects=Curriculum design" \
    -F "delivery=in-person" \
    -F "preferred_audiences=universities" \
    -F "languages=English" \
    -F "availability=weekdays" \
    -F "constraints=Evenings only" \
    -F "portfolio_links=https://example.com/p" \
    -F "consent_accuracy=on" \
    -F "consent_submission=on" \
    -F "consent_review=on" \
    -F "public_consent=$consent" \
    -F "cv=@$WORK/cv.pdf;type=application/pdf" \
    -F "photo=@$WORK/photo.png;type=image/png" >/dev/null 2>&1

  python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("id",""))' "$body" 2>/dev/null
}

# Get a session cookie for a reviewer. Writes the header value to stdout.
session_for() {
  curl -s "$BASE/__test/session?login=$1" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("cookie",""))' 2>/dev/null
}

# authed <cookie> <curl args...>
authed() { local cookie="$1"; shift; curl -s -H "Cookie: $cookie" "$@"; }

# code_of <cookie> <url>
code_of() { local cookie="$1"; shift; curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $cookie" "$@"; }

set_status() { # <id> <status> <note> -> http code
  local token
  token=$(csrf "$1")
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $COOKIE" \
    -H 'Accept: text/html' -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "csrf=$token" \
    --data-urlencode "status=$2" --data-urlencode "note=$3" \
    "$BASE/application/$1/status"
}

review_status() { # <id> -> the status shown on the page
  authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$1" \
    | grep -oE 'rv-status-[a-z-]+' | head -1 | sed 's/rv-status-//'
}

# The CSRF token the rendered page carries, read back out of the form.
#
# The tests take the token the way a browser does — from the page — so a change
# that broke the rendering would fail here rather than pass on a token the test
# invented.
csrf() { # <id> -> token
  authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$1" \
    | grep -oE 'name="csrf" value="[A-Za-z0-9_-]+"' | head -1 | sed -E 's/.*value="//; s/"//'
}

# post_json <id> <path> <token> <curl data args...> -> status code
#
# Asks for JSON so the status code is the outcome rather than a redirect, which
# is what lets a refusal be asserted as a refusal.
post_json() {
  local id="$1" path="$2" token="$3"; shift 3
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $COOKIE" \
    -H 'Accept: application/json' -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "csrf=$token" "$@" "$BASE/application/$id$path"
}

# ---- The repository stub ---------------------------------------------------

STUB="${STUB_PORT:-8803}"
STUB_BASE="http://127.0.0.1:${STUB}"

stub_reset()  { curl -s -o /dev/null -X POST "$STUB_BASE/__stub/reset" -d '{}' -H 'content-type: application/json'; }
stub_fail()   { curl -s -o /dev/null -X POST "$STUB_BASE/__stub/fail" -d "{\"mode\":\"$1\"}" -H 'content-type: application/json'; }
stub_files()  { curl -s "$STUB_BASE/__stub/state" | python3 -c 'import json,sys;print(" ".join(json.load(sys.stdin).get("files",[])))'; }
# A predicate, not a printer. `if stub_has ...` has to mean something, or every
# "this file is absent" assertion silently passes.
stub_has()    { stub_files | tr " " "\n" | grep -qxF "$1"; }
stub_yesno()  { if stub_has "$1"; then echo yes; else echo no; fi; }
# Matching a page through a pipe is a trap: `grep -q` exits at its first match,
# `printf` then dies of SIGPIPE, and under `set -o pipefail` the pipeline reports
# failure even though the match succeeded. Whether that happened depends on how
# much of the page grep read before closing, which is why it showed up as a
# passing assertion failing on some runs and not others. A here-string is not a
# pipeline, so these cannot lose a race.
has()     { grep -q    -- "$2" <<< "$1"; }
has_re()  { grep -qE   -- "$2" <<< "$1"; }
has_re_i(){ grep -qiE  -- "$2" <<< "$1"; }
# What the Contents API was actually asked for: the refs, and the paths. The
# branch tests read these back instead of trusting that the request could not
# have influenced them.
stub_refs()    { curl -s "$STUB_BASE/__stub/state" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("refs",[])))'; }
stub_paths()   { curl -s "$STUB_BASE/__stub/state" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin).get("files",[])))'; }
stub_refs_reset() { :; }
# The branch the Worker is deployed with, read from its own config so the
# expectation cannot drift from the deployment.
stub_configured_branch() {
  # Unset locally, so the Worker's own fallback applies, exactly as in production.
  local b
  b=$(grep -E '^[[:space:]]*REPOSITORY_BRANCH' .dev.vars 2>/dev/null | sed -E 's/.*=[[:space:]]*"?([^"[:space:]]+)"?.*/\1/')
  printf '%s' "${b:-main}"
}
stub_content(){ # <path> -> the file's text
  curl -s "$STUB_BASE/repos/test/test/contents/$1?ref=$(stub_configured_branch)" \
    | python3 -c 'import json,sys,base64;d=json.load(sys.stdin);print(base64.b64decode(d["content"]).decode("utf8", "replace"))' 2>/dev/null
}

# Seed the stub with the repository's real vocabulary, so the terms the intake
# form accepts are the terms the dashboard validates against. Reading the
# project's own file is the point: a second copy here would only prove the copy
# matches itself.
stub_seed_vocabulary() {
  python3 -c 'import json,sys;print(json.dumps({"path":sys.argv[1],"content":open(sys.argv[2]).read()}))' \
    "data/vocab/associates.yml" "../data/vocab/associates.yml" \
    | curl -s -o /dev/null -X POST "$STUB_BASE/__stub/seed" -H 'content-type: application/json' --data-binary @-
}

# Take the whole stand-in repository away and put it back exactly as it was.
# Several tests need the vocabulary missing or the directory unreadable, and
# re-running the earlier approvals to rebuild them would not produce the
# repository those sections asserted on.
PRESERVED="$WORK/preserved.json"
preserve_stub() { curl -s "$STUB_BASE/__stub/export" > "$PRESERVED"; }
restore_stub()  { curl -s -o /dev/null -X POST "$STUB_BASE/__stub/import" \
                   -H 'content-type: application/json' --data-binary @"$PRESERVED"; }
stub_ok()       { curl -s -o /dev/null -X POST "$STUB_BASE/__stub/fail" -d '{"mode":"ok"}' -H 'content-type: application/json'; }

# Seed an arbitrary stub file from a string.
stub_seed_file() { # <path> <content>
  python3 -c 'import json,sys;print(json.dumps({"path":sys.argv[1],"content":sys.argv[2]}))' "$1" "$2" \
    | curl -s -o /dev/null -X POST "$STUB_BASE/__stub/seed" -H 'content-type: application/json' --data-binary @-
}

# ---- 0. Preconditions ------------------------------------------------------

head1 "0. the dashboard and the intake Worker are both up"

if ! curl -s -o /dev/null --max-time 3 "$BASE/login"; then
  printf '  %s\n' "$(red 'The review dashboard is not answering on :'"$PORT"'.')"
  printf '  Start it with:  (cd review-worker && npx wrangler dev --port %s)\n' "$PORT"
  exit 2
fi
ok "the review dashboard answers on :$PORT"

if ! curl -s -o /dev/null --max-time 3 -X POST "http://127.0.0.1:${INTAKE}" \
     -H "Origin: http://localhost:8889" -H 'content-type: application/json' -d '{}'; then
  printf '  %s\n' "$(red 'The intake Worker is not answering on :'"${INTAKE%%/*}"' so no application can be seeded.')"
  printf '  Start it with:  (cd applications-worker && npx wrangler dev --port %s)\n' "${INTAKE%%/*}"
  exit 2
fi
ok "the intake Worker answers on :${INTAKE%%/*}"

# The intake Worker allows five submissions an hour per connection, and a suite
# run has just used them. Clearing the counter is what the intake test route is
# for; without it a second run cannot seed anything.
curl -s -o /dev/null -X POST "http://127.0.0.1:${INTAKE%%/*}/__test/reset-rate-limit" \
  -H "Origin: http://localhost:8889"
ok "the intake rate limit is cleared for this run"

YES_ID=$(seed yes  "Dana Okonkwo" "Riverside University")
NO_ID=$(seed  no   "Luis Fernandes" "Harbour Institute")
if [ -z "$YES_ID" ] || [ -z "$NO_ID" ]; then
  printf '  %s\n' "$(red 'Could not seed an application, so the review matrix cannot run.')"
  exit 2
fi
ok "seeded two applications (consent yes and consent no)"

# ---- 1. Authentication -----------------------------------------------------

head1 "1. authentication"

# A browser gets the sign-in page; an API client gets a bare 401. Neither gets
# an application.
check "no session, HTML request  -> redirected to sign-in" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: text/html' "$BASE/")" "302"

check "no session, JSON request  -> 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' "$BASE/")" "401"

check "no session, application page -> 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' "$BASE/application/$YES_ID")" "401"

check "no session, CV request    -> 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' "$BASE/file/$YES_ID?kind=cv")" "401"

check "no session, status change -> 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Accept: application/json' \
     -d 'status=approved' "$BASE/application/$YES_ID/status")" "401"

# An application id on its own is not a credential, and a guessed id leaks nothing.
check "a plausible but wrong id  -> 401 without a session" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' \
     "$BASE/application/app-20260101-000000000000")" "401"

COOKIE=$(session_for "$REVIEWER")
if [ -z "$COOKIE" ]; then
  printf '  %s\n' "$(red 'Could not mint a session. Is SESSION_SECRET set in .dev.vars and ALLOW_TEST_RESET=true?')"
  exit 2
fi

check "an allowed reviewer      -> 200 on the list"      "$(code_of "$COOKIE" -H 'Accept: text/html' "$BASE/")" "200"
check "an allowed reviewer      -> 200 on an application" "$(code_of "$COOKIE" -H 'Accept: text/html' "$BASE/application/$YES_ID")" "200"

# The header names the signed-in GitHub account. The shell is handed the whole
# session and every other caller reads `.login` off it, so rendering the session
# itself slips past a 324-check suite that never looked at this span.
for PAGE_NAME in list application; do
  case "$PAGE_NAME" in
    list)        PAGE_URL="$BASE/" ;;
    application) PAGE_URL="$BASE/application/$YES_ID" ;;
  esac
    HEADER_PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$PAGE_URL")
    # The span is `class="rv-account-name">`, so the quote is part of the match.
    SHOWN=$(grep -oE 'rv-account-name">[^<]*' <<<"$HEADER_PAGE" | head -1 | sed 's/rv-account-name">//')
    check "the $PAGE_NAME header names the GitHub login" "$SHOWN" "$REVIEWER"
    # Brackets escaped, or grep reads them as a character class that matches any
    # ordinary word and the check always fails.
    if has_re "$HEADER_PAGE" '\[object Object\]'; then
      bad "the $PAGE_NAME header renders no bare session object" "the page contained [object Object]"
    else
      ok "the $PAGE_NAME header renders no bare session object"
    fi
done

# A cookie for an account that is not on the list must be refused. The minter
# refuses to make one at all, which is the first half of the guarantee; a forged
# payload is the second.
check "minting a session for a stranger -> refused" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/__test/session?login=$STRANGER")" "403"

FORGED="fw_review_session=$(printf '{"login":"%s","exp":%s}' "$REVIEWER" "$(( $(date +%s) + 3600 ))" | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=').notarealsignature"
check "a hand-written cookie with a bad signature -> 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' -H "Cookie: $FORGED" "$BASE/")" "401"

TAMPERED="${COOKIE%.*}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
check "a tampered cookie signature -> 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' -H "Cookie: $TAMPERED" "$BASE/")" "401"

EXPIRED=$(curl -s "$BASE/__test/expired-session?login=$REVIEWER" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("cookie",""))' 2>/dev/null)
if [ -n "$EXPIRED" ]; then
  check "a correctly signed but expired cookie -> 401" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' -H "Cookie: $EXPIRED" "$BASE/")" "401"
else
  bad "a correctly signed but expired cookie -> 401" "could not mint an expired session"
fi

# The token is never in a page.
LOGIN_PAGE=$(curl -s -H 'Accept: text/html' "$BASE/login")
if grep <<<"$LOGIN_PAGE" -qiE 'gho_[A-Za-z0-9]{20,}|access_token|github_pat_'; then
  bad "the sign-in page carries no GitHub token" "a token-shaped string was present"
else
  ok "the sign-in page carries no GitHub token"
fi

# Every /__test/ route must sit behind the flag on the same line, so a test
# route cannot reach production by being added without its guard.
check "every test-only route is behind the ALLOW_TEST_RESET guard" \
  "$(grep -n '__test/' worker.js | grep -vc 'ALLOW_TEST_RESET')" "0"

# ---- 2. Application list ---------------------------------------------------

head1 "2. the application list"

LIST=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/")

if grep <<<"$LIST" -q "$YES_ID"; then ok "the list shows the consent-yes application"; else bad "the list shows the consent-yes application"; fi
if grep <<<"$LIST" -q "$NO_ID";  then ok "the list shows the consent-no application";  else bad "the list shows the consent-no application";  fi
if grep <<<"$LIST" -q 'Dana Okonkwo';  then ok "the list shows the applicant name";      else bad "the list shows the applicant name"; fi
if grep <<<"$LIST" -q 'Riverside University'; then ok "the list shows the organisation"; else bad "the list shows the organisation"; fi
if grep <<<"$LIST" -qi 'Consent: no'; then ok "the list shows the consent decision"; else bad "the list shows the consent decision"; fi
if grep <<<"$LIST" -q 'Submitted'; then ok "the list shows a status"; else bad "the list shows a status"; fi

# Newest first: the second seed is newer, so it comes first.
FIRST_ID=$(grep -oE -m1 'app-[0-9]{8}-[a-f0-9]{12}' <<<"$LIST")
if [ "$FIRST_ID" = "$NO_ID" ]; then ok "the newest application is first"; else bad "the newest application is first" "first was $FIRST_ID"; fi

for STATUS in under-review changes-requested approved rejected archived; do
  if grep <<<"$LIST" -q "?status=$STATUS"; then
    ok "the list offers the $STATUS filter"
  else
    bad "the list offers the $STATUS filter"
  fi
done

# A filtered list may legitimately hold rows left by an earlier run, so the
# invariant is that every row shown carries the status that was asked for.
for STATUS in approved under-review changes-requested; do
  FILTERED=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/?status=$STATUS")
  STRAY=$(printf '%s' "$FILTERED" \
    | grep -oE 'rv-status-[a-z-]+' | sort -u | grep -v "^rv-status-$STATUS$" | tr '\n' ' ')
  if [ -z "$STRAY" ]; then
    ok "filtering by $STATUS shows only $STATUS"
  else
    bad "filtering by $STATUS shows only $STATUS" "also showed: $STRAY"
  fi
done

# ---- 3. The review page ----------------------------------------------------

head1 "3. the review page"

PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$YES_ID")

for VALUE in "Dana Okonkwo" "Senior Lecturer" "Riverside University" "Course Lead" \
              "United Kingdom" "applicant@example.com" "PhD Education" \
              "Ten years lecturing" "Curriculum design" "Evenings only" ; do
  if grep <<<"$PAGE" -qF "$VALUE"; then ok "the review page shows: $VALUE"; else bad "the review page shows: $VALUE"; fi
done

if grep <<<"$PAGE" -q 'Public profile consent: <strong>YES'; then
  ok "consent YES is stated unambiguously"
else
  bad "consent YES is stated unambiguously"
fi

PAGE_NO=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$NO_ID")
if grep <<<"$PAGE_NO" -q 'Public profile consent: <strong>NO'; then
  ok "consent NO is stated unambiguously"
else
  bad "consent NO is stated unambiguously"
fi
if grep <<<"$PAGE_NO" -qi 'not.*agree.*published\|did <strong>not</strong> agree'; then
  ok "the NO case explains what it means"
else
  bad "the NO case explains what it means"
fi

# An unreadable id is not an error page that leaks anything.
check "an unknown application id -> 404 for a reviewer" \
  "$(code_of "$COOKIE" -H 'Accept: text/html' "$BASE/application/app-20260101-000000000000")" "404"

# ---- 4. CV and photograph access -------------------------------------------

head1 "4. CV and photograph access"

CV_TYPE=$(authed "$COOKIE" -o /dev/null -w '%{content_type}' "$BASE/file/$YES_ID?kind=cv")
if [ "$CV_TYPE" = "application/pdf" ]; then ok "the CV streams with its real type"; else bad "the CV streams with its real type" "got '$CV_TYPE'"; fi

CV_SIZE=$(authed "$COOKIE" "$BASE/file/$YES_ID?kind=cv" | wc -c | tr -d ' ')
if [ "$CV_SIZE" -gt 10 ]; then ok "the CV has content ($CV_SIZE bytes)"; else bad "the CV has content" "$CV_SIZE bytes"; fi

PHOTO_TYPE=$(authed "$COOKIE" -o /dev/null -w '%{content_type}' "$BASE/file/$YES_ID?kind=photo")
if [ "$PHOTO_TYPE" = "image/png" ]; then ok "the photograph streams with its real type"; else bad "the photograph streams with its real type" "got '$PHOTO_TYPE'"; fi

DISP=$(authed "$COOKIE" -o /dev/null -D - "$BASE/file/$YES_ID?kind=cv" | grep -i '^content-disposition' | tr -d '\r')
if grep <<<"$DISP" -qi 'attachment'; then ok "the CV downloads as an attachment"; else bad "the CV downloads as an attachment" "$DISP"; fi

DISP_P=$(authed "$COOKIE" -o /dev/null -D - "$BASE/file/$YES_ID?kind=photo&disposition=inline" | grep -i '^content-disposition' | tr -d '\r')
if grep <<<"$DISP_P" -qi 'inline'; then ok "the photograph can be viewed inline"; else bad "the photograph can be viewed inline" "$DISP_P"; fi

CACHE=$(authed "$COOKIE" -o /dev/null -D - "$BASE/file/$YES_ID?kind=cv" | grep -i '^cache-control' | tr -d '\r')
if grep <<<"$CACHE" -qi 'no-store'; then ok "a file response is not cacheable"; else bad "a file response is not cacheable" "$CACHE"; fi

# The key is taken from the stored record, so a crafted kind cannot walk out of
# the application's own folder.
check "a crafted file kind -> 404" \
  "$(code_of "$COOKIE" "$BASE/file/$YES_ID?kind=../application.json")" "404"
check "a file kind of record -> 404" \
  "$(code_of "$COOKIE" "$BASE/file/$YES_ID?kind=application")" "404"

# The generated key never carries the applicant's name.
if authed "$COOKIE" -o /dev/null -D - "$BASE/file/$YES_ID?kind=photo" | grep -qi 'dana\|okonkwo\|applicant@example'; then
  bad "the file name leaks nothing about the applicant" "an applicant name appeared in the headers"
else
  ok "the file name leaks nothing about the applicant"
fi

# ---- 5. Every state change needs a form and a token ------------------------

head1 "5. forms carry a CSRF token, and a post without one is refused"

TOKEN_YES=$(csrf "$YES_ID")
TOKEN_NO=$(csrf "$NO_ID")

if [ -n "$TOKEN_YES" ]; then ok "the review page carries a CSRF token"; else bad "the review page carries a CSRF token"; fi

# A post with no token, a wrong token, or someone else's token changes nothing.
for BAD in "" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $COOKIE" \
    -H 'Accept: application/json' -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "csrf=$BAD" --data-urlencode "status=rejected" \
    "$BASE/application/$YES_ID/status")
  if [ "$CODE" = "403" ]; then
    ok "a status post with token '${BAD:0:8}' -> 403"
  else
    bad "a status post with token '${BAD:0:8}' -> 403" "got $CODE"
  fi
done

check "the status is unchanged after the refused posts" "$(review_status "$YES_ID")" "submitted"

# A state-changing route reached by GET is not a page.
check "GET on a post route -> 405" "$(code_of "$COOKIE" "$BASE/application/$YES_ID/approve")" "405"
check "GET on the publication route -> 405" "$(code_of "$COOKIE" "$BASE/application/$YES_ID/publication")" "405"

# The sign-out form is a post too.
check "GET on /logout -> redirected, not a sign-out" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $COOKIE" "$BASE/logout")" "302"

# ---- 6. The status workflow ------------------------------------------------

head1 "6. the status workflow"

for STATUS in under-review changes-requested rejected archived; do
  CODE=$(set_status "$YES_ID" "$STATUS" "moving to $STATUS for the test")
  if [ "$CODE" = "302" ]; then
    if [ "$(review_status "$YES_ID")" = "$STATUS" ]; then
      ok "status $STATUS is set and persists"
    else
      bad "status $STATUS is set and persists" "page shows $(review_status "$YES_ID")"
    fi
  else
    bad "status $STATUS is set and persists" "POST returned $CODE"
  fi
done

# A browser is redirected back to the page rather than shown JSON.
check "a browser form post is redirected, not JSON" "$(set_status "$YES_ID" submitted "")" "302"
check "the same post as JSON reports 200" \
  "$(post_json "$YES_ID" /status "$(csrf "$YES_ID")" --data-urlencode 'status=under-review')" "200"

# A status outside the defined set is refused, as a real 400.
check "a status outside the defined set -> 400" \
  "$(post_json "$YES_ID" /status "$(csrf "$YES_ID")" --data-urlencode 'status=published')" "400"
check "the status is unchanged after a bad status" "$(review_status "$YES_ID")" "under-review"

# `approved` is not reachable through the generic route. It is what the approval
# action sets, together with the record it creates.
check "setting approved through /status -> 409" \
  "$(post_json "$YES_ID" /status "$(csrf "$YES_ID")" --data-urlencode 'status=approved')" "409"
check "the application is still not approved" "$(review_status "$YES_ID")" "under-review"

# Internal notes persist and are not public.
set_status "$NO_ID" under-review "Spoke with the applicant; CV is legible."
curl -s -o /dev/null -X POST -H "Cookie: $COOKIE" \
  -H 'Accept: application/json' -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrf=$(csrf "$NO_ID")" \
  --data-urlencode "note=Second note: strong candidate, timing to confirm." \
  "$BASE/application/$NO_ID/note"

check "an empty note -> 400" \
  "$(post_json "$NO_ID" /note "$(csrf "$NO_ID")" --data-urlencode 'note=   ')" "400"

NOTES_PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$NO_ID")
if grep <<<"$NOTES_PAGE" -qF 'Spoke with the applicant'; then ok "an internal note is stored and shown"; else bad "an internal note is stored and shown"; fi
if grep <<<"$NOTES_PAGE" -qF 'strong candidate, timing'; then ok "a second note is stored and shown"; else bad "a second note is stored and shown"; fi
if grep <<<"$NOTES_PAGE" -q 'status:under-review'; then ok "the history records the status change"; else bad "the history records the status change"; fi

# ---- 7. Consent ------------------------------------------------------------

head1 "7. consent"

review_consent() { # <id> -> yes / no / not recorded
  authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$1" \
    | grep -oE 'Public profile consent: <strong>(YES|NO|NOT RECORDED)</strong>' \
    | head -1 | sed -E 's/.*<strong>([^<]*)<.*/\1/' | tr 'A-Z' 'a-z' | tr -d ' '
}

check "the consent-yes application reads yes" "$(review_consent "$YES_ID")" "yes"
check "the consent-no application reads no"   "$(review_consent "$NO_ID")"  "no"

# A reviewer cannot set the consent flag: no route takes it. Carrying it on a
# status post has to change nothing at all.
post_json "$NO_ID" /status "$(csrf "$NO_ID")" \
  --data-urlencode 'status=under-review' --data-urlencode 'publication_permitted=true' >/dev/null
check "a status post carrying publication_permitted=true leaves consent alone" "$(review_consent "$NO_ID")" "no"

# Nor can they set it on the publication route, which is the one that matters.
# This application has no record yet, so the refusal here is about the record;
# the consent refusal on the same route is asserted in section 11.
check "a publication post carrying publication_permitted=true is refused" \
  "$(post_json "$NO_ID" /publication "$(csrf "$NO_ID")" \
     --data-urlencode 'action=public' --data-urlencode 'publication_permitted=true')" "409"
check "consent is still no after that attempt" "$(review_consent "$NO_ID")" "no"

# ---- 8. Approve & Create Associate ----------------------------------------

head1 "8. approving creates the record in the repository"

# A known starting point: the vocabulary, and one person who is already on the
# site. The second is not decoration. Git cannot hold an empty directory, so a
# repository with no `data/associates/` answers 404 to a directory read, and the
# dashboard refuses to approve — which is the fail-closed behaviour, not a
# limitation of the stand-in. The project repository has records in it; so does
# this.
stub_reset
stub_seed_vocabulary
stub_seed_file "data/associates/already-here.yml" "name: Someone Already Here
visibility: public
profile_status: active
"

check "the vocabulary is readable" "$(stub_yesno 'data/vocab/associates.yml')" "yes"
check "the existing records are readable" "$(stub_yesno 'data/associates/already-here.yml')" "yes"

# Nothing exists yet, so the id follows the repository convention: a slug of the
# applicant's name.
check "approving a new application -> 200" \
  "$(post_json "$YES_ID" /approve "$(csrf "$YES_ID")" --data-urlencode 'note=Accepted for the network.')" "200"
check "the application is now approved" "$(review_status "$YES_ID")" "approved"

EXPECTED_SLUG=$(printf '%s' "Dana Okonkwo" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g')
RECORD="data/associates/$EXPECTED_SLUG.yml"

check "the record was written at the expected path" "$(stub_yesno "$RECORD")" "yes"

YAML=$(stub_content "$RECORD")

# A small helper, so a check reads as the field it is about.
field() { printf '%s\n' "$YAML" | grep -F "$1" || true; }
has_field() { if printf '%s\n' "$YAML" | grep -qF "$1"; then ok "the record has: $1"; else bad "the record has: $1"; fi; }
lacks_field() { if printf '%s\n' "$YAML" | grep -qiF "$1"; then bad "the record does not have: $1"; else ok "the record does not have: $1"; fi; }

has_field "name: Dana Okonkwo"
has_field "title: Senior Lecturer"
has_field "organisation: Riverside University"
has_field "application_id: $YES_ID"
has_field "publication_permitted: true"
has_field "visibility: private"
has_field "profile_status: inactive"
has_field "consent_fingerprint: sha256:"

# The record says who approved it and when, so the provenance is in the file and
# not only in the dashboard's own state.
if printf '%s\n' "$YAML" | grep -q 'approved_by: '; then ok "the record names the approver"; else bad "the record names the approver"; fi
if printf '%s\n' "$YAML" | grep -qE 'approved_at: [0-9]{4}-[0-9]{2}-[0-9]{2}T'; then ok "the record is dated"; else bad "the record is dated"; fi

# Vocabulary terms are validated, and the ones the applicant chose are kept.
has_field "  - education-training"
has_field "  - trainer-facilitator"
has_field "  - education"
has_field "  - united-kingdom"
has_field "  - professional-training"

# The free-text public fields come across too.
has_field "summary:"
has_field "qualifications:"
has_field "  - PhD Education"
has_field "languages:"
has_field "  - English"

# The review-only fields must not reach a file that publishes to a website.
lacks_field "applicant@example.com"
lacks_field "availability"
lacks_field "Evenings only"
lacks_field "Course Lead"

# The record is a file in a public repository, so the consent decision and the
# digest of it are in it, and the answer as the applicant worded it and the
# moment they gave it are not. A record that quotes somebody back to themselves,
# with a timestamp on it, is administrative detail in a published file.
lacks_field "consent_public_profile"
lacks_field "consent_recorded_at"
has_field "publication_permitted:"
has_field "consent_fingerprint:"

# And no photograph: publishing one is its own decision, in section 10.
if printf '%s\n' "$YAML" | grep -qE '^photo:'; then
  bad "the record names no photograph" "a photo field was written"
else
  ok "the record names no photograph"
fi

# A term that is not in the vocabulary cannot reach the record. The intake form
# does not police its own values, so an application can carry anything, and the
# record is built from what the repository's vocabulary recognises.
BOGUS_ID=$(seed yes  "Ingrid Vandermeer" "Delta College")
BOGUS_TOKEN=$(csrf "$BOGUS_ID")
check "approving the second application -> 200" \
  "$(post_json "$BOGUS_ID" /approve "$BOGUS_TOKEN" --data-urlencode 'note=Second approver test.')" "200"

BOGUS_SLUG="ingrid-vandermeer"
check "the second record is written" "$(stub_yesno "data/associates/$BOGUS_SLUG.yml")" "yes"
if stub_content "data/associates/$BOGUS_SLUG.yml" | grep -qF "application_id: $BOGUS_ID"; then
  ok "the second record carries its own application id"
else
  bad "the second record carries its own application id"
fi

# A recognised term, on the same record, so this shows the vocabulary filtered
# rather than that nothing was written.
if stub_content "data/associates/$BOGUS_SLUG.yml" | grep -qF "  - education-training"; then
  ok "a vocabulary term reaches the second record"
else
  bad "a vocabulary term reaches the second record"
fi

# ---- 9. Idempotency and duplicates ----------------------------------------

head1 "9. approving twice, and refusing to overwrite"

check "approving again -> 200 already" \
  "$(post_json "$YES_ID" /approve "$(csrf "$YES_ID")" --data-urlencode 'note=Second click.')" "200"

BEFORE_FILES=$(stub_files)
post_json "$YES_ID" /approve "$(csrf "$YES_ID")" --data-urlencode 'note=Third click.' >/dev/null
check "a repeat approval writes no second file" "$(stub_files)" "$BEFORE_FILES"
check "the record is unchanged by the repeat" "$(stub_content "$RECORD" | grep -c 'application_id')" "1"

# The same name as an existing record must not overwrite it. A third applicant
# shares the first one's name, so the id has to move aside.
SAME_NAME_ID=$(seed yes "Dana Okonkwo" "Second Riverside")
check "approving a same-name application -> 200" \
  "$(post_json "$SAME_NAME_ID" /approve "$(csrf "$SAME_NAME_ID")" --data-urlencode 'note=Same name.')" "200"

SAME_NAME_FILE=$(stub_content "$RECORD")
if printf '%s\n' "$SAME_NAME_FILE" | grep -qF "application_id: $YES_ID"; then
  ok "the original record was not overwritten"
else
  bad "the original record was not overwritten" "the original application id is gone"
fi

if stub_has "data/associates/dana-okonkwo-2.yml"; then
  ok "the collision was given its own id (dana-okonkwo-2)"
else
  bad "the collision was given its own id (dana-okonkwo-2)" "files now: $(stub_files)"
fi
if stub_content "data/associates/dana-okonkwo-2.yml" | grep -qF "application_id: $SAME_NAME_ID"; then
  ok "the collision record holds the new application"
else
  bad "the collision record holds the new application"
fi

# A file the review knows nothing about is a real person: never overwritten.
UNKNOWN_ID=$(seed yes "Priya Raghunathan" "Epsilon Institute")
stub_seed_file "data/associates/priya-raghunathan.yml" "name: A Real Person
visibility: public
"
check "approving over an unknown existing record -> 200 with a suffixed id" \
  "$(post_json "$UNKNOWN_ID" /approve "$(csrf "$UNKNOWN_ID")" --data-urlencode 'note=Collision with a real record.')" "200"
if stub_content "data/associates/priya-raghunathan.yml" | grep -q 'name: A Real Person'; then
  ok "the unknown record kept its content"
else
  bad "the unknown record kept its content"
fi
if stub_has "data/associates/priya-raghunathan-2.yml"; then
  ok "the new record was written beside it, not over it"
else
  bad "the new record was written beside it, not over it" "files now: $(stub_files)"
fi

# ---- 10. Failing closed ----------------------------------------------------

head1 "10. when the repository cannot be checked, nothing is created"

FAIL_ID=$(seed yes "Tomas Bergstrom" "Zeta College")
FAIL_TOKEN=$(csrf "$FAIL_ID")

# 503 from the stand-in: "I could not list the existing records", which must not
# be read as "there are none".
stub_fail unavailable
BEFORE_FILES=$(stub_files)
check "approving with the directory unreadable -> 503" \
  "$(post_json "$FAIL_ID" /approve "$FAIL_TOKEN" --data-urlencode 'note=Should refuse.')" "503"
check "no record was created" "$(stub_yesno 'data/associates/tomas-bergstrom.yml')" "no"
check "nothing at all was written" "$(stub_files)" "$BEFORE_FILES"
check "the application is not approved" "$(review_status "$FAIL_ID")" "submitted"

# An unauthorised token is a configuration problem, and is reported as one.
stub_fail unauthorised
check "approving with the token refused -> 503" \
  "$(post_json "$FAIL_ID" /approve "$FAIL_TOKEN" --data-urlencode 'note=Should refuse.')" "503"
check "still no record" "$(stub_yesno 'data/associates/tomas-bergstrom.yml')" "no"

# A write that is refused because the file moved under us. The read still works:
# the dashboard can see the directory, chooses a free id, and only the write is
# refused — so this is a conflict about the file, not an inability to check.
stub_ok
stub_fail stale
check "approving when the write is refused -> 409" \
  "$(post_json "$FAIL_ID" /approve "$FAIL_TOKEN" --data-urlencode 'note=Should refuse.')" "409"
check "the application is still not approved" "$(review_status "$FAIL_ID")" "submitted"

# With the repository answering again, the same approval goes through.
stub_ok
check "the same approval succeeds once the repository answers -> 200" \
  "$(post_json "$FAIL_ID" /approve "$FAIL_TOKEN" --data-urlencode 'note=Retried.')" "200"
check "the record exists now" "$(stub_yesno 'data/associates/tomas-bergstrom.yml')" "yes"

# ---- 11. Publication is a separate decision --------------------------------

head1 "11. publication, and the consent that gates it"

check "the consent-no application is approved -> 200" \
  "$(post_json "$NO_ID" /approve "$(csrf "$NO_ID")" --data-urlencode 'note=Accepted; consent is no.')" "200"
check "the consent-no application is approved" "$(review_status "$NO_ID")" "approved"

NO_SLUG=$(printf '%s' "Luis Fernandes" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g')
NO_RECORD="data/associates/$NO_SLUG.yml"
check "the consent-no record was created" "$(stub_yesno "$NO_RECORD")" "yes"
if stub_content "$NO_RECORD" | grep -q 'publication_permitted: false'; then
  ok "the consent-no record carries publication_permitted false"
else
  bad "the consent-no record carries publication_permitted false"
fi

# Kept so the hand edit below starts from what the dashboard actually wrote,
# rather than from something a test assembled.
stub_content "$NO_RECORD" > "$WORK/no-record.yml"

# The refusal, which is the whole point.
check "publishing a consent-no record -> 403" \
  "$(post_json "$NO_ID" /publication "$(csrf "$NO_ID")" --data-urlencode 'action=public')" "403"
if stub_content "$NO_RECORD" | grep -q 'visibility: public'; then
  bad "the consent-no record stayed private" "it was made public"
else
  ok "the consent-no record stayed private"
fi

# The panel offers no Public button either.
NO_PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$NO_ID")
if has "$NO_PAGE" 'Public publication is not permitted'; then
  ok "the panel states that publication is not permitted"
else
  bad "the panel states that publication is not permitted"
fi
if has "$NO_PAGE" 'value="public"'; then
  bad "no Public control is offered" "a public control was rendered"
else
  ok "no Public control is offered"
fi

# An action that is not one of the two is not an action.
check "an invented publication action -> 409" \
  "$(post_json "$NO_ID" /publication "$(csrf "$NO_ID")" --data-urlencode 'action=delete')" "409"

# Consent refuses publishing, not taking down. A record that is nonetheless
# exposed — here because the repository was edited by hand — has to be
# withdrawable without consent, because that action cannot publish anybody.
# Both of them, because the site publishes on both: a public but inactive record
# is not actually on the site, and there would be nothing to take down.
stub_seed_file "$NO_RECORD" "$(sed -E -e 's/^visibility: private/visibility: public/' \
  -e 's/^profile_status: inactive/profile_status: active/' < "$WORK/no-record.yml")"
if stub_content "$NO_RECORD" | grep -q 'visibility: public' && stub_content "$NO_RECORD" | grep -q 'profile_status: active'; then
  ok "the consent-no record was made public by hand in the repository"
else
  bad "the consent-no record was made public by hand in the repository" "the edit did not apply"
fi

RECOVERY_PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$NO_ID")
if has "$RECOVERY_PAGE" 'Make Private'; then
  ok "an exposed consent-no record can still be taken down"
else
  bad "an exposed consent-no record can still be taken down" "no Make Private control was offered"
fi
if has "$RECOVERY_PAGE" 'value="public"'; then
  bad "taking down still offers no Public control" "a public control was rendered"
else
  ok "taking down still offers no Public control"
fi

check "unpublishing a consent-no record -> 200" \
  "$(post_json "$NO_ID" /publication "$(csrf "$NO_ID")" --data-urlencode 'action=private')" "200"
if stub_content "$NO_RECORD" | grep -q 'visibility: private'; then
  ok "the exposed consent-no record is private again"
else
  bad "the exposed consent-no record is private again" "the record is: $(stub_content "$NO_RECORD" | grep -E '^(visibility|profile_status|publication_permitted):' | tr '\n' ' ')"
fi

# Publication before approval is refused, on a fresh application.
PUB_EARLY_ID=$(seed yes "Noor Haddad" "Eta University")
check "publishing before approval -> 409" \
  "$(post_json "$PUB_EARLY_ID" /publication "$(csrf "$PUB_EARLY_ID")" --data-urlencode 'action=public')" "409"

# Now the consent-yes case: private until a reviewer says otherwise.
check "the consent-yes record is private after approval" \
  "$(stub_content "$RECORD" | grep -c 'visibility: private')" "1"
YES_PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$YES_ID")
if has "$YES_PAGE" 'Make Public'; then
  ok "the panel offers Make Public for a consenting record"
else
  # Say which of the three early returns the panel took, or this failure says
  # nothing about why.
  bad "the panel offers Make Public for a consenting record" \
    "panel said: $(grep -oE 'not permitted by the applicant|could not be read from the|but that file is not in the repository|Approved|Consent</dt>[^<]*<dd[^>]*>[^<]*|Profile</dt>[^<]*<dd[^>]*>[^<]*' <<< "$YES_PAGE" | tr '\n' '|')"
fi

check "publishing a consent-yes record -> 200" \
  "$(post_json "$YES_ID" /publication "$(csrf "$YES_ID")" --data-urlencode 'action=public')" "200"
check "the record is now public" "$(stub_content "$RECORD" | grep -c 'visibility: public')" "1"
check "the record is now active" "$(stub_content "$RECORD" | grep -c 'profile_status: active')" "1"

# Publishing again writes nothing and is reported as already there.
BEFORE=$(stub_content "$RECORD")
check "publishing again -> 200" \
  "$(post_json "$YES_ID" /publication "$(csrf "$YES_ID")" --data-urlencode 'action=public')" "200"
check "the record is byte-for-byte unchanged" "$(stub_content "$RECORD")" "$BEFORE"

# A CMS edit that is not visibility survives a publication change.
BEFORE=$(stub_content "$RECORD")
post_json "$YES_ID" /publication "$(csrf "$YES_ID")" --data-urlencode 'action=private' >/dev/null
if stub_content "$RECORD" | grep -q 'visibility: private'; then
  ok "unpublishing sets the record private"
else
  bad "unpublishing sets the record private"
fi
if stub_content "$RECORD" | grep -q 'profile_status: active'; then
  ok "unpublishing leaves profile_status alone, so being published is not erased"
else
  bad "unpublishing leaves profile_status alone, so being published is not erased"
fi

# An unapproved record cannot be published even with consent.
check "publication still needs a record" \
  "$(post_json "$PUB_EARLY_ID" /publication "$(csrf "$PUB_EARLY_ID")" --data-urlencode 'action=public')" "409"

# ---- 12. The fingerprint that detects a consent change --------------------

head1 "12. a consent that changes after approval is detected, not assumed"

FP_RECORD=$(printf '%s\n' "$YAML" | grep 'consent_fingerprint' | sed -E 's/.*(sha256:[a-f0-9]+).*/\1/')
if [ -n "$FP_RECORD" ]; then
  ok "the record carries a consent fingerprint"
else
  bad "the record carries a consent fingerprint"
fi

# The dashboard records the same fingerprint in its own review state, and that is
# what the publication route compares a fresh read against. Two different digests
# would mean every publication is refused, so their agreeing is a real property
# worth asserting rather than assuming.
FP_REVIEW=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$YES_ID" \
  | grep -oE 'sha256:[a-f0-9]{64}' | head -1)
if [ "$FP_REVIEW" = "$FP_RECORD" ]; then
  ok "the review state and the record hold the same fingerprint"
else
  bad "the review state and the record hold the same fingerprint" "record=$FP_RECORD review=$FP_REVIEW"
fi

# What the fingerprint does: it digests the application's consent block, so a
# different answer gives a different digest. That is the whole detection
# mechanism, and it is pure, so it can be checked exactly.
if node --input-type=module -e '
  import { consentFingerprint } from "./lib/store.js";
  const base = { id: "app-20260101-000000000000", consent: { publication_permitted: true, public_profile: "yes", recorded_at: "2026-01-01T00:00:00.000Z" } };
  const stable = await consentFingerprint(structuredClone(base));
  const flipped = await consentFingerprint({ ...base, consent: { ...base.consent, publication_permitted: false } });
  const retimed = await consentFingerprint({ ...base, consent: { ...base.consent, recorded_at: "2026-02-02T00:00:00.000Z" } });
  if (!/^sha256:[a-f0-9]{64}$/.test(stable)) throw new Error("not a sha256 digest: " + stable);
  if (stable !== (await consentFingerprint(structuredClone(base)))) throw new Error("not stable for the same input");
  if (stable === flipped) throw new Error("a changed consent answer is not detected");
  if (stable === retimed) throw new Error("a changed consent timestamp is not detected");
' >"$WORK/fingerprint.log" 2>&1; then
  ok "the fingerprint is stable, and changes when the consent does"
else
  bad "the fingerprint is stable, and changes when the consent does" "$(tr '\n' ' ' < "$WORK/fingerprint.log")"
fi

# No route can change consent, which is why the mismatch branch is not reachable
# from a browser at all: the only way the stored answer changes is out of band.
if grep -qE 'guard\.form\.get\("(consent|publication_permitted)"\)' worker.js; then
  bad "no route reads consent from a request" "a route reads it from the form"
else
  ok "no route reads consent from a request"
fi

# ---- 13. The photograph is its own decision --------------------------------

head1 "13. the photograph is never published as a side effect"

check "the consent-no record names no photograph" \
  "$(stub_content "$NO_RECORD" | grep -c '^photo:' || true)" "0"

# The consent-no applicant uploaded a photograph, and it stays in private storage.
check "publishing a photograph without consent -> 403" \
  "$(post_json "$NO_ID" /photo "$(csrf "$NO_ID")")" "403"
if stub_files | tr ' ' '\n' | grep -q "^static/images/$NO_SLUG"; then
  bad "no photograph was written for the consent-no record" "a file was written"
else
  ok "no photograph was written for the consent-no record"
fi

# The private copy is still served to a reviewer afterwards.
PHOTO_TYPE=$(authed "$COOKIE" -o /dev/null -w '%{content_type}' "$BASE/file/$NO_ID?kind=photo")
if [ "$PHOTO_TYPE" = "image/png" ]; then
  ok "the private photograph is still readable by a reviewer after the refusal"
else
  bad "the private photograph is still readable by a reviewer after the refusal" "got '$PHOTO_TYPE'"
fi

# With consent, the photograph is published on request and only on request.
check "publishing a photograph with consent -> 200" \
  "$(post_json "$YES_ID" /photo "$(csrf "$YES_ID")")" "200"
check "the image was written to static/images" "$(stub_yesno "static/images/$EXPECTED_SLUG.png")" "yes"
check "the record now names the photograph" \
  "$(stub_content "$RECORD" | grep -c "^photo: /images/$EXPECTED_SLUG.png")" "1"

# A second attempt writes nothing, and does not fail.
BEFORE=$(stub_content "$RECORD")
check "publishing the photograph again -> 200" "$(post_json "$YES_ID" /photo "$(csrf "$YES_ID")")" "200"
check "the record is unchanged by the repeat" "$(stub_content "$RECORD")" "$BEFORE"

# Approving a record never writes an image: the check above is on a record that
# was approved in section 8, before any photograph action.
if stub_has "static/images/$BOGUS_SLUG.png"; then
  bad "approval wrote no photograph" "an image appeared for the second approval"
else
  ok "approval wrote no photograph"
fi

# ---- 14. The public site is untouched by a private application --------------

head1 "14. the public site"

check "the public origin is not a route here" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://frontlineworld.org' \
     "$BASE/application/$YES_ID")" "401"

LIST_HTML=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/")
if grep <<<"$LIST_HTML" -qi 'Dana Okonkwo'; then
  ok "the applicant name appears to a reviewer"
else
  bad "the applicant name appears to a reviewer"
fi

# And to nobody else.
if curl -s -H 'Accept: text/html' "$BASE/" | grep -qi 'Dana Okonkwo'; then
  bad "the applicant name does not appear without a session" "it was in the unauthenticated response"
else
  ok "the applicant name does not appear without a session"
fi

# Nothing was written to the project's own repository. Everything in this suite
# went to the stand-in, which holds it in memory.
if grep -qs "$YES_ID" ../data/associates/*.yml 2>/dev/null; then
  bad "the real repository has no record from this run" "a record appeared in data/associates"
else
  ok "the real repository has no record from this run"
fi
if [ -e "../static/images/$EXPECTED_SLUG.png" ]; then
  bad "the real repository has no photograph from this run" "an image appeared in static/images"
else
  ok "the real repository has no photograph from this run"
fi

# ---- 15. The write surface is two folders ----------------------------------

head1 "15. only two folders can ever be written"

# `assertWritablePath` is the backstop that makes "a reviewer could name any
# file" impossible rather than merely unintended, so it is worth checking
# directly rather than only through the routes that happen to call it.
if node --input-type=module -e '
  import { assertWritablePath } from "./lib/repository.js";
  const allowed = [
    "data/associates/dana-okonkwo.yml",
    "static/images/dana-okonkwo.jpg",
    "static/images/dana-okonkwo.png",
    "static/images/dana-okonkwo.webp",
  ];
  const refused = [
    "",
    ".",
    "..",
    "../data/associates/x.yml",
    "data/associates/../../secrets.yml",
    "data/associates/x.yml.bak",
    "data/associates/x.YML",
    "data/associates/-leading-dash.yml",
    "data/associates/UPPER.yml",
    "data/associates/x.yaml",
    "data/associates/nested/x.yml",
    "data/vocab/associates.yml",
    "data/associates",
    "static/images/../../hugo.toml",
    "static/images/x.gif",
    "static/images/x.php",
    "static/x.png",
    "layouts/partials/x.html",
    "static/images/x.png%00.yml",
    "/data/associates/x.yml",
    "data\\associates\\x.yml",
  ];
  const bad = [...allowed.filter((p) => !assertWritablePath(p)), ...refused.filter((p) => assertWritablePath(p))];
  if (bad.length) throw new Error("wrong verdict for: " + bad.join(", "));
  if (assertWritablePath(null) || assertWritablePath(42) || assertWritablePath({})) throw new Error("non-string accepted");
' >"$WORK/paths.log" 2>&1; then
  ok "the path allowlist admits two folders and refuses everything else"
else
  bad "the path allowlist admits two folders and refuses everything else" "$(tr '\n' ' ' < "$WORK/paths.log")"
fi

# A path in a request is not a path in the repository. No route reads one.
if grep -nE 'form\.get\("(path|file|filename|content|yaml|record)"\)' worker.js | grep -qv '^\s*$'; then
  bad "no route takes a repository path from a request" "a route reads one from the form"
else
  ok "no route takes a repository path from a request"
fi

# From here the records the earlier sections created have to survive, so the
# repository is snapshotted before the one section that needs it gone.
preserve_stub

# ---- 16. The vocabulary reader fails closed -------------------------------

head1 "16. the vocabulary reader fails closed"

# A reader that returned a short list would strip terms off every record it
# approved, so an unrecognised shape has to be refused rather than guessed at.
if node --input-type=module -e '
  import { parseVocabulary } from "./lib/repository.js";
  const real = (await import("node:fs")).readFileSync("../data/vocab/associates.yml", "utf8");
  const good = parseVocabulary(real);
  if (!good) throw new Error("the project vocabulary was refused");
  for (const key of ["expertise", "roles", "contributions", "sectors", "regions"]) {
    if (!good[key] || good[key].length === 0) throw new Error("missing " + key);
  }
  const complete = "expertise:\n  - id: a\n    label: A\nroles:\n  - id: b\n    label: B\ncontributions:\n  - id: c\n    label: C\nsectors:\n  - id: d\n    label: D\nregions:\n  - id: e\n    label: E\n";
  if (!parseVocabulary(complete)) throw new Error("a complete vocabulary was refused");
  const refused = [
    ["empty", ""],
    ["blank", "   "],
    ["one list only", "expertise:\n  - id: a\n    label: A\n"],
    ["no lists at all", "not: a vocabulary\n"],
    ["a missing key", "expertise:\n  - id: a\n    label: A\nsectors:\n  - id: d\n    label: D\nregions:\n  - id: e\n    label: E\n"],
    ["a key with an empty list", "expertise:\nroles:\n  - id: b\ncontributions:\n  - id: c\nsectors:\n  - id: d\nregions:\n  - id: e\n"],
    ["an id with trailing text", "expertise:\n  - id: a b\n    label: A\nroles:\n  - id: b\ncontributions:\n  - id: c\nsectors:\n  - id: d\nregions:\n  - id: e\n"],
    ["a label where an id belongs", "expertise:\n  - label: A\nroles:\n  - id: b\ncontributions:\n  - id: c\nsectors:\n  - id: d\nregions:\n  - id: e\n"],
    ["a list at the wrong indent", "expertise:\n- id: a\nroles:\n  - id: b\ncontributions:\n  - id: c\nsectors:\n  - id: d\nregions:\n  - id: e\n"],
  ];
  const bad = refused.filter(([, text]) => parseVocabulary(text) !== null).map(([name]) => name);
  if (bad.length) throw new Error("wrongly accepted: " + bad.join(", "));
' >"$WORK/vocab.log" 2>&1; then
  ok "the vocabulary reader accepts the real file and refuses malformed ones"
else
  bad "the vocabulary reader accepts the real file and refuses malformed ones" "$(tr '\n' ' ' < "$WORK/vocab.log")"
fi

# With the vocabulary gone, no record is built at all.
stub_reset
VAGUE_ID=$(seed yes "Hana Yoshida" "Theta Institute")
VAGUE_TOKEN=$(csrf "$VAGUE_ID")
check "approving with no vocabulary -> 502" \
  "$(post_json "$VAGUE_ID" /approve "$VAGUE_TOKEN" --data-urlencode 'note=Should refuse.')" "502"
check "no record was created without a vocabulary" "$(stub_yesno 'data/associates/hana-yoshida.yml')" "no"
check "the application is not approved without a vocabulary" "$(review_status "$VAGUE_ID")" "submitted"

# The repository as the earlier sections left it, vocabulary included.
restore_stub
check "the same approval succeeds once the vocabulary is back -> 200" \
  "$(post_json "$VAGUE_ID" /approve "$VAGUE_TOKEN" --data-urlencode 'note=Retried.')" "200"

# ---- 17. The site build honours what the dashboard wrote -------------------

head1 "17. the site build, given the records this run created"

if command -v hugo >/dev/null 2>&1; then
  SITE="$WORK/site"
  mkdir -p "$SITE"
  # A copy, so the project's own working tree is not touched by a test.
  (cd .. && tar cf - --exclude=public --exclude=resources --exclude=.git .) | (cd "$SITE" && tar xf -)

  cp "$(cd .. && pwd)/data/vocab/associates.yml" "$SITE/data/vocab/associates.yml" 2>/dev/null
  # Take the records the stand-in holds and put them where Hugo reads them.
  for FILE in $(stub_files | tr ' ' '\n' | grep '^data/associates/'); do
    mkdir -p "$SITE/$(dirname "$FILE")"
    stub_content "$FILE" > "$SITE/$FILE"
  done
  for FILE in $(stub_files | tr ' ' '\n' | grep '^static/images/'); do
    mkdir -p "$SITE/$(dirname "$FILE")"
    printf 'stub image' > "$SITE/$FILE"
  done

  # Section 11 took this record back down, so publishing it here is the whole
  # point of the section: the dashboard writes a record, and the site build
  # picks it up with no other step in between.
  check "publishing the consented record before building -> 200" \
  "$(post_json "$YES_ID" /publication "$(csrf "$YES_ID")" --data-urlencode 'action=public')" "200"
  stub_content "$RECORD" > "$WORK/record-before-build.yml"
  for FILE in $(stub_files | tr ' ' '\n' | grep '^data/associates/'); do
    mkdir -p "$SITE/$(dirname "$FILE")"
    stub_content "$FILE" > "$SITE/$FILE"
  done

  # The consent-no record must not reach the public site whatever it says.
  if grep -q 'visibility: public' "$SITE/$NO_RECORD"; then
    bad "the consent-no record is not public before building" "it was public"
  else
    ok "the consent-no record is not public before building"
  fi

  BUILD_LOG="$WORK/hugo.log"
  (cd "$SITE" && hugo --minify --baseURL "https://mwamer.github.io/Frontline-World-LTD/" --logLevel info --destination "$SITE/out" > "$BUILD_LOG" 2>&1)
  if grep -q 'Total in' "$BUILD_LOG"; then
    ok "the site builds with the created records"
  else
    bad "the site builds with the created records" "$(tail -3 "$BUILD_LOG" | tr '\n' ' ')"
  fi

  # The minified HTML drops attribute quotes, so a page check has to be written
  # the way a browser reads it rather than against pretty-printed source.
  PROFILE="$SITE/out/people/$EXPECTED_SLUG/index.html"
  if [ -f "$PROFILE" ]; then
    ok "the published profile is generated"
  else
    bad "the published profile is generated" "no page at people/$EXPECTED_SLUG/"
  fi
  if grep -q "$EXPECTED_SLUG.png" "$PROFILE"; then
    ok "the profile page references the published photograph"
  else
    bad "the profile page references the published photograph"
  fi
  # Each paragraph of a long biography has to come out as its own paragraph, or
  # a pasted CV reads as one wall of text.
  ABOUT=$(python3 -c '
import re, sys
html = open(sys.argv[1]).read()
section = html.split("id=profile-about")[-1].split("</section>")[0]
print(len(re.findall(r"<p>", section)))
' "$PROFILE" 2>/dev/null)
  check "both biography paragraphs render" "$ABOUT" "2"
  # The vocabulary is joined to its label at build time; a raw id would mean the
  # record and the vocabulary have drifted apart.
  if grep -q 'Education & Training' "$PROFILE"; then
    ok "expertise renders as its vocabulary label, not its id"
  else
    bad "expertise renders as its vocabulary label, not its id" "the page has: $(grep -o 'class=profile-tag>[^<]*' "$PROFILE" | head -3 | tr '\n' ' ')"
  fi
  # Nothing administrative reaches the page, least of all the application id and
  # the consent detail.
  for LEAKED in "consent_public_profile" "consent_recorded_at" "$YES_ID"; do
    if grep -q "$LEAKED" "$PROFILE"; then
      bad "the profile page carries no private detail" "$LEAKED is on the page"
    else
      ok "the profile page carries no private detail"
    fi
  done

  SITEMAP="$SITE/out/sitemap.xml"
  if [ -f "$SITEMAP" ]; then
    if grep -q "/people/$EXPECTED_SLUG/" "$SITEMAP"; then
      ok "the published profile is in the sitemap"
    else
      bad "the published profile is in the sitemap" "the sitemap has: $(grep -o '/people/[a-z0-9-]*/' "$SITEMAP" | tr '\n' ' ')"
    fi
    if grep -q "/people/$NO_SLUG/" "$SITEMAP"; then
      bad "the consent-no profile is not in the sitemap" "it was published"
    else
      ok "the consent-no profile is not in the sitemap"
    fi
    # A private record is a valid record; it is simply not listed.
    if [ -f "$SITE/out/people/$NO_SLUG/index.html" ]; then
      bad "the consent-no profile is not generated at all" "a page was built for it"
    else
      ok "the consent-no profile is not generated at all"
    fi
  else
    bad "the sitemap exists" "no sitemap was written"
  fi

  # A consent answer that is not a real boolean is not a consent. A quoted
  # "true" or a capital "yes" in the YAML must not publish anyone, because a gate
  # that is lenient about the shape of its own input is a gate that can be walked
  # past with a text editor.
  # The literal line, not a value to interpolate, so that the quoted forms really
  # are quoted in the file.
  printf 'name: Quoted\npublication_permitted: "true"\nvisibility: public\nprofile_status: active\n' \
    > "$SITE/data/associates/zz-quoted.yml"
  printf 'name: Capital\npublication_permitted: "yes"\nvisibility: public\nprofile_status: active\n' \
    > "$SITE/data/associates/zz-capital.yml"
  printf 'name: Bare\npublication_permitted: true\nvisibility: public\nprofile_status: active\n' \
    > "$SITE/data/associates/zz-bare.yml"
  (cd "$SITE" && rm -rf out && hugo --minify --baseURL "https://mwamer.github.io/Frontline-World-LTD/" --logLevel info --destination "$SITE/out" > "$WORK/hugo3.log" 2>&1)
  for SLUG in zz-quoted zz-capital; do
    if [ -f "$SITE/out/people/$SLUG/index.html" ]; then
      bad "a quoted consent answer does not publish" \
        "$SLUG was built; the file was: $(tr '\n' '|' < "$SITE/data/associates/$SLUG.yml")"
    else
      ok "a quoted consent answer does not publish"
    fi
  done
  if [ -f "$SITE/out/people/zz-bare/index.html" ]; then
    ok "a real boolean consent answer does publish"
  else
    bad "a real boolean consent answer does publish" "zz-bare was not built"
  fi
  rm -f "$SITE/data/associates/zz-quoted.yml" "$SITE/data/associates/zz-capital.yml" \
        "$SITE/data/associates/zz-bare.yml"

  # The last check is the one that matters. Somebody sets the consent-no record
  # public in the CMS by hand, and the site build must still leave it out,
  # because the gate needs the consent field and the record says false.
  sed -i '' -e 's/^visibility: private/visibility: public/' \
            -e 's/^profile_status: inactive/profile_status: active/' "$SITE/$NO_RECORD" 2>/dev/null
  if grep -q '^visibility: public' "$SITE/$NO_RECORD" && grep -q '^profile_status: active' "$SITE/$NO_RECORD"; then
    ok "the consent-no record was forced public in the copy"
  else
    bad "the consent-no record was forced public in the copy" "the edit did not apply"
  fi

  (cd "$SITE" && rm -rf out && hugo --minify --baseURL "https://mwamer.github.io/Frontline-World-LTD/" --logLevel info --destination "$SITE/out" > "$WORK/hugo2.log" 2>&1)
  if grep -q "/people/$NO_SLUG/" "$SITE/out/sitemap.xml" || [ -f "$SITE/out/people/$NO_SLUG/index.html" ]; then
    bad "a hand-edited consent-no record is still not published" "it reached the output: $(grep -o '/people/[a-z0-9-]*/' "$SITE/out/sitemap.xml" | tr '\n' ' ')"
  else
    ok "a hand-edited consent-no record is still not published"
  fi
  # The consented record is still there, so the two are being told apart by the
  # consent field rather than by the visibility or the status.
  if grep -q "/people/$EXPECTED_SLUG/" "$SITE/out/sitemap.xml"; then
    ok "the consented record is still published after the other was forced public"
  else
    bad "the consented record is still published after the other was forced public" "the sitemap has: $(grep -o '/people/[a-z0-9-]*/' "$SITE/out/sitemap.xml" | tr '\n' ' ')"
  fi
else
  printf '  %s\n' "hugo is not installed; the build section was skipped"
fi

# ---- 18. Retention ---------------------------------------------------------

# The retention clock cannot be driven through the dashboard: a rejection 400
# days into its period cannot be produced by clicking buttons, because the
# reviewer who made it is long gone. These run the policy and the sweep directly
# against an in-memory R2, with the clock pinned, and are counted into the same
# total so a pass is a pass of everything.
# The identity request GitHub receives cannot be checked through the dashboard,
# because a header missing from it looks exactly like a successful sign-in until
# the request reaches GitHub and comes back 403. These run the real callback over
# a captured `fetch` and read the request it built.
head1 "18. The GitHub identity request"
OAUTH_LOG="$WORK/oauth-headers.log"
if node test-oauth-headers.js > "$OAUTH_LOG" 2>&1; then
  OAUTH_PASS=$(sed -E 's/\x1b\[[0-9;]*m//g' "$OAUTH_LOG" | sed -n 's/^Passed: \([0-9]*\).*/\1/p')
  OAUTH_FAIL=$(sed -E 's/\x1b\[[0-9;]*m//g' "$OAUTH_LOG" | sed -n 's/^Passed: [0-9]* *Failed: \([0-9]*\).*/\1/p')
  PASS=$((PASS + ${OAUTH_PASS:-0}))
  FAIL=$((FAIL + ${OAUTH_FAIL:-1}))
  printf '  %s  the headers the identity request is sent with (%s checks)\n' "$(green PASS)" "${OAUTH_PASS:-0}"
else
  FAIL=$((FAIL + 1))
  printf '  %s  the headers the identity request is sent with\n' "$(red FAIL)"
  sed -E 's/\x1b\[[0-9;]*m//g' "$OAUTH_LOG" | grep -E '^  FAIL|^         ' | sed 's/^/  /'
fi

# ---- 18b. Retention ---------------------------------------------------------

head1 "18b. Retention"
RETENTION_LOG="$WORK/retention.log"
if node test-retention.js > "$RETENTION_LOG" 2>&1; then
  RETENTION_PASS=$(sed -E 's/\x1b\[[0-9;]*m//g' "$RETENTION_LOG" | sed -n 's/^Passed: \([0-9]*\).*/\1/p')
  RETENTION_FAIL=$(sed -E 's/\x1b\[[0-9;]*m//g' "$RETENTION_LOG" | sed -n 's/^Passed: [0-9]* *Failed: \([0-9]*\).*/\1/p')
  PASS=$((PASS + ${RETENTION_PASS:-0}))
  FAIL=$((FAIL + ${RETENTION_FAIL:-1}))
  printf '  %s  the retention policy and sweep (%s checks)\n' "$(green PASS)" "${RETENTION_PASS:-0}"
  # Surface any individual failure, because a single lumped line hides which
  # rule broke.
  sed -E 's/\x1b\[[0-9;]*m//g' "$RETENTION_LOG" | grep -E '^  FAIL|^          ' | sed 's/^/  /'
else
  FAIL=$((FAIL + 1))
  printf '  %s  the retention policy and sweep\n' "$(red FAIL)"
  sed -E 's/\x1b\[[0-9;]*m//g' "$RETENTION_LOG" | grep -E '^  FAIL|^          ' | sed 's/^/  /'
fi

# ---- 19. Retention through the dashboard -----------------------------------

# The decision logic is proven above. This proves the wiring: that a withdrawal
# is recorded with a reason, that a hold can be set and cleared, and that the
# manual sweep is guarded exactly like every other write.
head1 "19. Retention through the dashboard"

WITHDRAWN_ID=$(seed no "Retention Withdrawal" "Withdrawn Org")

if [ -n "$WITHDRAWN_ID" ]; then
  wt() { post_json "$WITHDRAWN_ID" /status "$(csrf "$WITHDRAWN_ID")" "$@"; }

  # A withdrawal with no reason is refused. The policy deletes these in thirty
  # days, and a deletion nobody wrote down is not defensible.
  check "a withdrawal with no reason is refused" \
    "$(wt --data-urlencode 'status=withdrawn')" "400"
  check "a withdrawal with a reason is accepted" \
    "$(wt --data-urlencode 'status=withdrawn' --data-urlencode 'note=applicant asked to withdraw')" "200"

  PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$WITHDRAWN_ID")
  if has "$PAGE" "Scheduled for deletion"; then ok "the page says when it will be deleted"; else bad "the page says when it will be deleted"; fi
  # Thirty days out, from a withdrawal recorded moments ago.
  # Flattened first: the markup wraps between the <dt> and the <dd>, and grep
  # matches line by line.
  FLAT=$(printf '%s' "$PAGE" | tr '\n' ' ')
  if has_re "$FLAT" 'Scheduled for deletion</dt>[[:space:]]*<dd[^>]*>[0-9]{4}-[0-9]{2}-[0-9]{2}T'; then
    ok "and the date is a real timestamp after the decision"
  else
    bad "and the date is a real timestamp after the decision" "$(grep -oE 'Scheduled for deletion.{0,90}' <<< "$FLAT" | head -1)"
  fi
  # Thirty days from today, which is what the policy says for a withdrawal.
  EXPECTED_DUE=$(python3 -c 'import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=30)).date())')
  if has "$FLAT" "$EXPECTED_DUE"; then
    ok "and it is thirty days out, as the policy says"
  else
    bad "and it is thirty days out, as the policy says" "expected a date containing $EXPECTED_DUE"
  fi
  if has "$PAGE" "30 days\|Withdrawn"; then ok "and the withdrawn status is shown"; else bad "and the withdrawn status is shown"; fi

  # A hold needs both halves; one alone is not a hold.
  check "a hold date with no reason is refused" \
    "$(wt --data-urlencode 'status=withdrawn' --data-urlencode 'note=x' --data-urlencode 'retain_until=2099-01-01')" "400"
  check "a hold reason with no date is refused" \
    "$(wt --data-urlencode 'status=withdrawn' --data-urlencode 'note=x' --data-urlencode 'retain_reason=dispute')" "400"
  check "a hold with both halves is accepted" \
    "$(wt --data-urlencode 'status=withdrawn' --data-urlencode 'note=x' \
        --data-urlencode 'retain_reason=dispute with applicant' --data-urlencode 'retain_until=2099-01-01')" "200"

  PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$WITHDRAWN_ID")
  if has "$PAGE" "On hold until"; then ok "the hold is shown on the page"; else bad "the hold is shown on the page"; fi

  # Clearing both releases it, which is how a hold is lifted.
  check "clearing both fields releases the hold" \
    "$(wt --data-urlencode 'status=withdrawn' --data-urlencode 'note=resolved' \
        --data-urlencode 'retain_until=' --data-urlencode 'retain_reason=')" "200"
  PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$WITHDRAWN_ID")
  if has "$PAGE" "On hold until"; then bad "the hold is released" "the page still shows a hold"; else ok "the hold is released"; fi

  # `withdrawn` is a real status, so it is filterable.
  if authed "$COOKIE" -H 'Accept: text/html' "$BASE/?status=withdrawn" | grep -q "Retention Withdrawal"; then
    ok "withdrawn appears as a filter"
  else
    bad "withdrawn appears as a filter"
  fi
  # And `approved` is still not settable by hand, whatever else the form offers.
  check "approved is still not settable by hand" \
    "$(wt --data-urlencode 'status=approved')" "409"
else
  bad "the retention dashboard tests" "could not seed an application"
fi

# ---- 20. The manual sweep is guarded ---------------------------------------

# Running the sweep is a delete. It has to be as hard to reach as one.
head1 "20. The manual sweep is guarded"

check "an unauthenticated sweep is refused" "$(code_of "" -X POST "$BASE/retention/run")" "401"
check "a sweep with a session but no token is refused" "$(code_of "$COOKIE" -X POST "$BASE/retention/run")" "403"
check "a sweep by GET is refused" "$(code_of "$COOKIE" "$BASE/retention/run")" "405"

ROOT_TOKEN=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/" | grep -oE 'name="csrf" value="[A-Za-z0-9_-]+"' | head -1 | sed -E 's/.*value="//; s/"//')
check "a sweep with a session and a token runs" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $COOKIE" -H 'Accept: application/json' \
      -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "csrf=$ROOT_TOKEN" "$BASE/retention/run")" "200"

# Everything seeded here is under review or freshly withdrawn, so a real sweep
# must remove nothing. This is the assertion that would fail if retention were
# keyed on age instead of on status.
HOME_PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/")
# Pattern matching on the string rather than a pipe: `grep -q` exits at the first
# match, so piping a large page into it gives printf a broken pipe and eats the
# detail this failure depends on.
case "$HOME_PAGE" in
  *"0 deleted"*) ok "the sweep deleted nothing, because nothing had expired" ;;
  *) bad "the sweep deleted nothing, because nothing had expired" \
       "report: $(printf '%s' "$HOME_PAGE" | tr '<' '\n' | grep -A2 'Retention sweep last ran' | tr -d '\n' | cut -c1-200)" ;;
esac
case "$HOME_PAGE" in
  *"No failures"*|*"0 could not be completed"*|*"Retention sweep last ran"*)
    ok "the sweep reports its result on the list page" ;;
  *) bad "the sweep reports its result on the list page" "no retention report on the list page" ;;
esac

# ---- 21. An internal failure tells the reviewer nothing useful --------------

# Every route returns `await` inside the try, so a thrown error becomes this
# page. A bare `return fn()` would leave the try before the promise settled and
# the caller would receive a stack trace naming worker.js and a bucket key, which
# is exactly what the catch exists to prevent.
#
# The fault is injected by the GitHub stub, which can be told to fail a read, so
# this exercises the real path rather than a copy of it.
head1 "21. An internal failure does not leak internals"

# `unavailable` makes every read and write fail, which is what an outage of the
# Contents API looks like from here. `ok` clears it again without touching the
# files, so the rest of the suite still has its repository.
stub_fail "unavailable"
FAULT_ID=$(seed no "Fault Probe Applicant" "Fault Org")
FAULT_TOKEN=$(csrf "$FAULT_ID")
FAULT_BODY=$(curl -s -X POST -H "Cookie: $COOKIE" -H 'Accept: application/json' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrf=$FAULT_TOKEN" "$BASE/application/$FAULT_ID/approve")
stub_fail "ok"

# The refusal is a refusal, and it explains itself without naming a file.
if has "$FAULT_BODY" '"outcome":"refused"'; then ok "a failing read refuses rather than approving"; else bad "a failing read refuses rather than approving" "$FAULT_BODY"; fi

# A read failure on a page is a 500 with a plain message, not a stack.
FAULT_PAGE=$(authed "$COOKIE" -H 'Accept: text/html' "$BASE/application/$FAULT_ID")
if has_re_i "$FAULT_PAGE" 'worker\.js|lib/[a-z]+\.js|file:///|RangeError|TypeError|\bat [A-Za-z]+ \('; then
  bad "a page failure leaks no file names or stack frames" \
    "$(grep -oiE 'worker\.js|lib/[a-z]+\.js|at [A-Za-z]+ \(' <<< "$FAULT_PAGE" | sort -u | tr '\n' ' ')"
else
  ok "a page failure leaks no file names or stack frames"
fi

# The same for an unauthenticated caller, who must not be shown internals either.
UNauth=$(curl -s -H 'Accept: application/json' "$BASE/application/$FAULT_ID")
if has_re_i "$UNauth" 'worker\.js|file:///|RangeError'; then
  bad "an unauthenticated failure leaks nothing either"
else
  ok "an unauthenticated failure leaks nothing either"
fi

# ---- 22. The branch and the repository are not browser-supplied -------------
#
# For the production E2E run the Worker is deployed with its write target pinned
# to a throwaway branch, and it must be impossible to move that target from a
# request. `REPOSITORY_BRANCH` and `GITHUB_REPO` are only ever read from the
# environment, so the way to prove it is to post a full set of hostile values
# and then read back what the Contents API was actually asked for.
head1 "22. The branch and the repository are not browser-supplied"

HOSTILE_ID=$(seed yes "Branch Probe Applicant" "Probe Org")
HOSTILE_TOKEN=$(csrf "$HOSTILE_ID")
stub_refs_reset
curl -s -o /dev/null -X POST -H "Cookie: $COOKIE" -H 'Accept: application/json' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrf=$HOSTILE_TOKEN" \
  --data-urlencode "status=under-review" \
  --data-urlencode "branch=attacker-chosen-branch" \
  --data-urlencode "ref=attacker-chosen-branch" \
  --data-urlencode "GITHUB_REPO=attacker/attacker" \
  --data-urlencode "REPOSITORY_BRANCH=main" \
  --data-urlencode "path=../../../../etc/passwd" \
  --data-urlencode "ref_override=main" \
  "$BASE/application/$HOSTILE_ID/approve"
# Writes only. A read tells you nothing about where an approval would commit.
WRITES=$(stub_refs | python3 -c 'import json,sys; print(",".join(sorted({r["ref"] for r in json.load(sys.stdin) if r["method"]=="PUT"})))')
REFS_USED="$WRITES"

# The stub is reached through GITHUB_API_BASE, so the repo in the URL is proof
# the fixed repository was used. A moved repo would not reach the stub at all.
if [ -n "$REFS_USED" ]; then ok "the approval reached the configured repository"; else bad "the approval reached the configured repository" "no call reached the Contents API"; fi
if [ "$REFS_USED" = "$(stub_configured_branch)" ]; then
  ok "and every write used the server-side branch ($REFS_USED)"
else
  bad "and every write used the server-side branch" "wrote to: $REFS_USED, configured: $(stub_configured_branch)"
fi
# The posted branch is a value the deployment could never legitimately use, so
# its absence from the recorded refs is proof it was ignored rather than merely
# coinciding with the real target.
if stub_refs | grep -q 'attacker-chosen-branch'; then
  bad "a posted branch did not redirect the write" "the API was asked for the branch from the request"
else
  ok "a posted branch did not redirect the write"
fi
# No path outside the two writable folders was ever requested.
if stub_paths | grep -qvE '^(data/associates|data/vocab|static/images)/' ; then
  bad "no write landed outside the two writable folders" "$(stub_paths | grep -vE '^(data/associates|data/vocab|static/images)/' | head -3)"
else
  ok "no write landed outside the two writable folders"
fi

# ---- Summary ---------------------------------------------------------------

printf '\n\033[1mPassed: %s   Failed: %s\033[0m\n' "$PASS" "$FAIL"
printf 'seeded applications: %s (consent yes), %s (consent no)\n' "$YES_ID" "$NO_ID"
printf 'records in the stand-in repository: %s\n' "$(stub_files | tr ' ' '\n' | grep -c '^data/associates/')"

if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
