#!/usr/bin/env bash
# Test matrix for the associate application Worker.
#
# Runs against a local `wrangler dev --local` instance, so the R2 and KV
# bindings are the real emulations and nothing leaves the machine. Every value
# used here is invented.
#
#   ./test.sh [port]

set -uo pipefail

PORT="${1:-8801}"
ENDPOINT="http://127.0.0.1:${PORT}/submit"
# Test-only routes hang off the port, not off /submit.
BASE="http://127.0.0.1:${PORT}"
ORIGIN="http://localhost:8889"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ---- fixtures --------------------------------------------------------------

make_png() { # minimal valid 1x1 PNG
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$1"
}
make_pdf() { printf '%%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$1"; }
make_docx() { printf 'PK\x03\x04\x14\x00\x00\x00\x00\x00dummy-docx-body' > "$1"; }
make_doc()  { printf '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1legacy-word' > "$1"; }
make_exe()  { printf 'MZ\x90\x00\x03\x00\x00\x00this is not a document' > "$1"; }

make_png "$WORK/photo.png"
make_pdf "$WORK/cv.pdf"
make_docx "$WORK/cv.docx"
make_doc "$WORK/cv.doc"
make_exe "$WORK/cv.exe"
# Oversize: 9 MB of PNG-prefixed bytes, over the 8 MB photograph limit.
{ make_png "$WORK/big.png"; head -c 9000000 /dev/zero; } > "$WORK/photo-huge.png"
# Oversize CV: 6 MB, over the 5 MB limit.
{ make_pdf "$WORK/huge.pdf"; head -c 6000000 /dev/zero; } > "$WORK/cv-huge.pdf"

# The rate limiter counts per IP with no IP set locally, so every request looks
# like it came from the same client. The counter is reset between phases so a
# test is never refused for a previous test's traffic; the limit itself is
# tested on its own, at the end.
reset_rate_limit() {
  curl -s -o /dev/null -X POST "${BASE}/__test/reset-rate-limit" -H "Origin: $ORIGIN"
}

# A complete, valid submission. Overridable per test.
submit() {
  local name="Test Applicant" email="test.applicant@example.com" consent="yes" \
        cv="$WORK/cv.pdf" photo="$WORK/photo.png" honeypot="" skip_consent=0 skip_bio=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --email) email="$2"; shift 2 ;;
      --consent) consent="$2"; shift 2 ;;
      --cv) cv="$2"; shift 2 ;;
      --photo) photo="$2"; shift 2 ;;
      --honeypot) honeypot="$2"; shift 2 ;;
      --no-consent) skip_consent=1; shift ;;
      --no-bio) skip_bio=1; shift ;;
      *) shift ;;
    esac
  done

  local args=(
    -F "name=$name" -F "title=Senior Lecturer" -F "organisation=Test University"
    -F "current_role=Researcher" -F "email=$email" -F "country=United Kingdom"
    -F "public_consent=$consent" -F "company_website=$honeypot"
  )
  [ "$skip_bio" -eq 0 ] && args+=(-F "bio_short=An invented biography written for the test suite only.")
    [ "$skip_bio" -eq 0 ] && args+=(-F "expertise=strategic-foresight")
  [ "$skip_consent" -eq 0 ] && args+=(
    -F "consent_accuracy=on" -F "consent_submission=on" -F "consent_review=on"
  )
  [ -n "$cv" ] && args+=(-F "cv=@${cv};filename=$(basename "$cv")")
  [ -n "$photo" ] && args+=(-F "photo=@${photo};filename=$(basename "$photo")")

  curl -s -o "$WORK/body.json" -w '%{http_code}' -X POST "$ENDPOINT" \
    -H "Origin: $ORIGIN" "${args[@]}"
}

check() { # name expected actual
  if [ "$2" = "$3" ]; then
    printf '  \033[32mPASS\033[0m  %-52s %s\n' "$1" "$3"; PASS=$((PASS+1))
  else
    printf '  \033[31mFAIL\033[0m  %-52s expected %s, got %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1))
    head -c 300 "$WORK/body.json" 2>/dev/null | sed 's/^/          /'; echo
  fi
}

body_has() { grep -q "$1" "$WORK/body.json" && echo yes || echo no; }

reset_rate_limit
echo
echo "=== 1. valid application ==="
code=$(submit)
check "accepts a valid application" 200 "$code"
check "  returns a success message" yes "$(body_has 'received and will be reviewed')"
APP_ID=$(python3 -c "import json;print(json.load(open('$WORK/body.json')).get('id',''))" 2>/dev/null)
printf '        application id: %s\n' "${APP_ID:-<none>}"

reset_rate_limit
echo
echo "=== 2. missing required field ==="
code=$(submit --no-consent)
check "refuses a missing consent tick" 422 "$code"
code=$(curl -s -o "$WORK/body.json" -w '%{http_code}' -X POST "$ENDPOINT" -H "Origin: $ORIGIN" \
  -F "name=No Email" -F "title=T" -F "organisation=O" -F "current_role=R" -F "country=UK" \
  -F "bio_short=b" -F "expertise=strategic-foresight" -F "consent_accuracy=on" -F "consent_submission=on" -F "consent_review=on" \
  -F "public_consent=yes" -F "cv=@$WORK/cv.pdf" -F "photo=@$WORK/photo.png")
check "refuses a missing email" 422 "$code"
check "  names the field" yes "$(body_has 'email')"

reset_rate_limit
echo
echo "=== 3. invalid CV type ==="
code=$(submit --cv "$WORK/cv.exe")
check "refuses an executable as a CV" 422 "$code"

reset_rate_limit
echo
echo "=== 4. oversized CV ==="
code=$(submit --cv "$WORK/cv-huge.pdf")
check "refuses a CV over 5 MB" 422 "$code"
check "  explains the size limit" yes "$(body_has 'larger than')"

reset_rate_limit
echo
echo "=== 5. invalid photograph type ==="
code=$(submit --photo "$WORK/cv.pdf")
check "refuses a PDF as a photograph" 422 "$code"

reset_rate_limit
echo
echo "=== 6. oversized photograph ==="
code=$(submit --photo "$WORK/photo-huge.png")
check "refuses a photograph over 8 MB" 422 "$code"

reset_rate_limit
echo
echo "=== 7. malformed request ==="
code=$(curl -s -o "$WORK/body.json" -w '%{http_code}' -X POST "$ENDPOINT" -H "Origin: $ORIGIN" \
  -H "content-type: application/json" -d '{"not":"multipart"}')
check "refuses a non-multipart body" 400 "$code"
code=$(curl -s -o "$WORK/body.json" -w '%{http_code}' -X POST "$ENDPOINT" -H "Origin: $ORIGIN" \
  -H 'content-type: multipart/form-data; boundary=nope' --data-binary 'x')
check "refuses an unparseable multipart body" 400 "$code"
code=$(curl -s -o "$WORK/body.json" -w '%{http_code}' -X POST "$ENDPOINT" -H "Origin: $ORIGIN" --data-binary 'garbage')
check "refuses a urlencoded body with no fields" 422 "$code"

reset_rate_limit
echo
echo "=== 8. honeypot ==="
code=$(submit --honeypot "http://spam.example")
check "silently accepts a filled honeypot" 200 "$code"
check "  but returns no real id" yes "$(body_has '\"id\":\"received\"')"

echo
echo "=== 9. CORS preflight ==="
code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$ENDPOINT" -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type")
check "answers preflight from the site" 204 "$code"
hdr=$(curl -s -D - -o /dev/null -X OPTIONS "$ENDPOINT" -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: POST")
check "  echoes the exact origin" yes "$(echo "$hdr" | grep -qi "access-control-allow-origin: $ORIGIN" && echo yes || echo no)"
check "  never sends a wildcard" no "$(echo "$hdr" | grep -qi 'access-control-allow-origin: \*' && echo yes || echo no)"

echo
echo "=== 10. invalid origin ==="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ENDPOINT" -H "Origin: https://evil.example" \
  -F "name=X" -F "public_consent=yes")
check "refuses a POST from another origin" 403 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ENDPOINT" \
  -F "name=X" -F "public_consent=yes")
check "refuses a POST with no origin" 403 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$ENDPOINT" -H "Origin: https://evil.example" -H "Access-Control-Request-Method: POST")
check "refuses preflight from another origin" 403 "$code"

reset_rate_limit
echo
echo "=== 11. invalid consent ==="
code=$(submit --consent "maybe")
check "refuses a consent value that is not yes/no" 422 "$code"
code=$(curl -s -o "$WORK/body.json" -w '%{http_code}' -X POST "$ENDPOINT" -H "Origin: $ORIGIN" \
  -F "name=X" -F "title=T" -F "organisation=O" -F "current_role=R" -F "email=a@b.co" -F "country=UK" \
  -F "bio_short=b" -F "expertise=strategic-foresight" -F "consent_accuracy=on" -F "consent_submission=on" -F "consent_review=on" \
  -F "public_consent=yes" -F "company_website=" -F "cv=@$WORK/cv.pdf" -F "photo=@$WORK/photo.png")
check "accepts an empty honeypot" 200 "$code"

echo
echo "=== 12/13. consent is stored, and never auto-publishes ==="
code=$(submit --consent "no" --name "Consent Refused" --email "no.consent@example.com")
check "stores an application with consent = no" 200 "$code"
NO_ID=$(python3 -c "import json;print(json.load(open('$WORK/body.json')).get('id',''))" 2>/dev/null)
code=$(submit --consent "yes" --name "Consent Given" --email "yes.consent@example.com")
check "stores an application with consent = yes" 200 "$code"
YES_ID=$(python3 -c "import json;print(json.load(open('$WORK/body.json')).get('id',''))" 2>/dev/null)
echo "        no-consent id:  ${NO_ID:-<none>}"
echo "        yes-consent id: ${YES_ID:-<none>}"

echo
echo "=== 14. rate limiting ==="
for i in 1 2 3 4 5 6 7; do
  last=$(submit --name "Rate Probe $i" --email "rate$i@example.com")
done
check "stops accepting after the window limit" 429 "$last"

echo
echo "=== 15. wrong method / path ==="
code=$(curl -s -o /dev/null -w '%{http_code}' -X GET "$ENDPOINT" -H "Origin: $ORIGIN")
check "refuses GET on /submit" 405 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$ENDPOINT/submit" -H "Origin: $ORIGIN")
check "refuses an unknown path" 404 "$code"

echo
echo "=== 16. a partial write is rolled back ==="
reset_rate_limit
submit --consent "yes" --name "Rollback Target" --email "will.rollback@example.com" >/dev/null
GOOD_ID=$(python3 -c "import json;print(json.load(open('$WORK/body.json')).get('id',''))" 2>/dev/null)
list_objects() {  # $1 = prefix
  curl -s "${BASE}/__test/list?prefix=$1" -H "Origin: $ORIGIN"
}
good_keys=$(list_objects "applications/$GOOD_ID/" | python3 -c "
import json,sys
ks=[o['key'].split('/')[2] for o in json.load(sys.stdin).get('objects',[])]
print(len(ks), '|', ' '.join(sorted(ks)))")
check "the good submission stored record, cv and photo" yes \
  "$(echo "$good_keys" | grep -q 'application.json.*cv.*photo' && echo yes || echo no)"
before=$(curl -s "${BASE}/__test/list" -H "Origin: $ORIGIN" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('objects',[])))")
reset_rate_limit
# Fault injection routes exist only locally (ALLOW_TEST_RESET); production
# wrangler.toml never sets it.
code=$(curl -s -o "$WORK/body.json" -w '%{http_code}' -X POST "$ENDPOINT" -H "Origin: $ORIGIN" \
  -F "name=X" -F "title=T" -F "organisation=O" -F "current_role=R" -F "email=fault@example.com" \
  -F "country=UK" -F "bio_short=b" -F "expertise=strategic-foresight" \
  -F "consent_accuracy=on" -F "consent_submission=on" -F "consent_review=on" \
  -F "public_consent=yes" -F "__test_fault=photo_fails" \
  -F "cv=@$WORK/cv.pdf" -F "photo=@$WORK/photo.png")
check "reports the failure as a 500" 500 "$code"
after=$(curl -s "${BASE}/__test/list" -H "Origin: $ORIGIN" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('objects',[])))")
check "the half-written photo left no orphan behind it" "$before" "$after"

echo
printf '  \033[1mPassed: %d   Failed: %d\033[0m\n' "$PASS" "$FAIL"
echo
echo "  ids for the storage checks: ${APP_ID} ${NO_ID} ${YES_ID} ${GOOD_ID}"
[ "$FAIL" -eq 0 ]
