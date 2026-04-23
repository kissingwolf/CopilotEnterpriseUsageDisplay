#!/usr/bin/env bash
set -u

STRICT=false
if [[ "${1:-}" == "--strict" ]]; then
  STRICT=true
fi

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

log_pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf "[PASS] %s\n" "$1"
}

log_warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf "[WARN] %s\n" "$1"
}

log_fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf "[FAIL] %s\n" "$1"
}

is_int() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

status_label() {
  case "$1" in
    401) echo "token invalid or expired" ;;
    403) echo "permission denied (role or scope)" ;;
    404) echo "resource not found (wrong enterprise slug or feature disabled)" ;;
    422) echo "validation error" ;;
    5??) echo "github server error" ;;
    000) echo "network or timeout error" ;;
    *) echo "unexpected status" ;;
  esac
}

api_status() {
  local url="$1"
  local status
  status=$(curl -sS -o /dev/null -w "%{http_code}" \
    --connect-timeout 8 \
    --max-time 20 \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "$url" 2>/dev/null || true)

  if [[ -z "$status" ]]; then
    echo "000"
  else
    echo "$status"
  fi
}

# Load .env if present.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# 1) Environment checks
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  log_fail "ENV: GITHUB_TOKEN is required"
fi
if [[ -z "${ENTERPRISE_SLUG:-}" ]]; then
  log_fail "ENV: ENTERPRISE_SLUG is required"
fi

if [[ -n "${CACHE_TTL:-}" ]] && ! is_int "${CACHE_TTL}"; then
  log_fail "ENV: CACHE_TTL must be an integer"
fi
if [[ -n "${INCLUDED_QUOTA:-}" ]] && ! is_int "${INCLUDED_QUOTA}"; then
  log_fail "ENV: INCLUDED_QUOTA must be an integer"
fi
if [[ -n "${PORT:-}" ]] && ! is_int "${PORT}"; then
  log_fail "ENV: PORT must be an integer"
fi

if [[ $FAIL_COUNT -eq 0 ]]; then
  log_pass "ENV: required vars present"
fi

GITHUB_API_BASE="${GITHUB_API_BASE:-https://api.github.com}"
API_HOST=$(printf "%s" "$GITHUB_API_BASE" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##')
if [[ -z "$API_HOST" ]]; then
  log_fail "ENV: GITHUB_API_BASE is invalid"
fi

# 2) DNS and network checks
if command -v nslookup >/dev/null 2>&1; then
  if nslookup "$API_HOST" >/dev/null 2>&1; then
    log_pass "NET: DNS resolved for $API_HOST"
  else
    log_fail "NET: DNS resolution failed for $API_HOST"
  fi
else
  log_warn "NET: nslookup not found, DNS check skipped"
fi

if curl -sS -I --connect-timeout 5 --max-time 12 "https://${API_HOST}" >/dev/null 2>&1; then
  log_pass "NET: ${API_HOST}:443 reachable"
else
  log_fail "NET: cannot reach ${API_HOST}:443"
fi

# Stop early if fatal errors already exist.
if [[ $FAIL_COUNT -gt 0 ]]; then
  printf "\nSummary: PASS=%d WARN=%d FAIL=%d\n" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  exit 1
fi

# 3) Token validity
status=$(api_status "${GITHUB_API_BASE}/user")
if [[ "$status" == "200" ]]; then
  log_pass "AUTH: token valid"
else
  status_meta=$(api_status "${GITHUB_API_BASE}/meta")
  if [[ "$status_meta" == "200" ]]; then
    log_pass "AUTH: token works on /meta"
  else
    log_fail "AUTH: /user=${status}, /meta=${status_meta} ($(status_label "$status"))"
  fi
fi

# 4) Enterprise seats check (required for this dashboard)
status=$(api_status "${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/copilot/billing/seats")
if [[ "$status" == "200" ]]; then
  log_pass "API: seats endpoint accessible"
else
  log_fail "API: seats endpoint status=${status} ($(status_label "$status"))"
fi

# 5) Premium usage check (required for this dashboard)
YEAR=$(date +%Y)
MONTH=$(date +%-m)
status=$(api_status "${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/premium_request/usage?year=${YEAR}&month=${MONTH}")
if [[ "$status" == "200" ]]; then
  log_pass "API: premium usage endpoint accessible"
else
  log_fail "API: premium usage endpoint status=${status} ($(status_label "$status"))"
fi

# 6) Cost center feature probe (optional)
status=$(api_status "${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/cost-centers")
case "$status" in
  200) log_pass "API: cost-centers feature available" ;;
  404) log_warn "API: cost-centers feature not enabled (404)" ;;
  403) log_warn "API: cost-centers permission denied (403)" ;;
  *) log_warn "API: cost-centers check status=${status} ($(status_label "$status"))" ;;
esac

# 7) Budget feature probe (optional)
status=$(api_status "${GITHUB_API_BASE}/enterprises/${ENTERPRISE_SLUG}/settings/billing/budgets")
case "$status" in
  200) log_pass "API: budgets feature available" ;;
  404) log_warn "API: budgets feature not enabled (404)" ;;
  403) log_warn "API: budgets permission denied (403)" ;;
  *) log_warn "API: budgets check status=${status} ($(status_label "$status"))" ;;
esac

printf "\nSummary: PASS=%d WARN=%d FAIL=%d\n" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"

if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi

if [[ "$STRICT" == "true" && $WARN_COUNT -gt 0 ]]; then
  echo "Strict mode enabled: WARN treated as FAIL"
  exit 1
fi

exit 0
