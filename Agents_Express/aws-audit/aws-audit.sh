#!/usr/bin/env bash
# aws-audit.sh — read-only inventory of an AWS account, with full logging.
#
# Every command and its output is appended to a timestamped log file so the
# run is reproducible and auditable. Only non-mutating (describe/list/get)
# calls are used.
#
# Usage:
#   export AWS_DEFAULT_REGION=us-east-1
#   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=...
#   ./aws-audit.sh
#
# Credentials are read from the environment only — never hardcoded here.

set -uo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="$(dirname "$0")/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/audit-${STAMP}.log"

log() { printf '%s\n' "$*" | tee -a "$LOG"; }

run() {
  # run "<description>" <aws args...>
  local desc="$1"; shift
  log ""
  log "=================================================================="
  log "### ${desc}"
  log "# \$ aws $* --region ${REGION}"
  log "# $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "------------------------------------------------------------------"
  aws "$@" --region "$REGION" 2>&1 | tee -a "$LOG"
  log "------------------------------------------------------------------"
}

log "AgentExpress AWS audit — ${STAMP}"
log "Region: ${REGION}"

run "Caller identity"                 sts get-caller-identity
run "Account aliases"                 iam list-account-aliases
run "AWS Organizations: describe org" organizations describe-organization
run "AWS Organizations: list accounts" organizations list-accounts
run "IAM users"                       iam list-users
run "IAM roles"                       iam list-roles
run "IAM groups"                      iam list-groups
run "IAM account summary"             iam get-account-summary
run "S3 buckets"                      s3api list-buckets
run "EC2 instances"                   ec2 describe-instances
run "EC2 regions"                     ec2 describe-regions
run "VPCs"                            ec2 describe-vpcs
run "Lambda functions"                lambda list-functions
run "Bedrock foundation models"       bedrock list-foundation-models
run "Bedrock AgentCore runtimes"      bedrock-agentcore-control list-agent-runtimes
run "CloudFormation stacks"           cloudformation describe-stacks

log ""
log "=================================================================="
log "Audit complete. Full log: ${LOG}"
