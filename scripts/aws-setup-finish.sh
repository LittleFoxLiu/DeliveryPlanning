#!/usr/bin/env bash
# Finishes the AWS Agent Toolkit setup after you have run `aws login` yourself.
#
#   1. run:  aws login --profile aws-toolkit      (opens a browser; sign in)
#   2. run:  bash scripts/aws-setup-finish.sh
#
# Steps 4, 5, 5-tail and 6 of aws/agent-toolkit-for-aws setup.md.
set -euo pipefail

PROFILE="${AWS_PROFILE_NAME:-aws-toolkit}"
TOOLKIT_REGION="us-east-1"   # the Agent Toolkit service only runs in us-east-1
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

echo "==> Step 4: verify credentials for profile '$PROFILE'"
if ! aws sts get-caller-identity --profile "$PROFILE"; then
  echo "!! No valid credentials. Run:  aws login --profile $PROFILE   then re-run this script." >&2
  exit 1
fi

echo
echo "==> Step 5: install AI coding agents + AWS skills + the AWS MCP server"
echo "    (interactive wizard — answer any prompts)"
aws configure agent-toolkit --yes --region "$TOOLKIT_REGION" --profile "$PROFILE"

echo
echo "==> Step 5 tail: point the generated aws-mcp server at profile '$PROFILE'"
node scripts/aws-mcp-set-profile.mjs "$PROFILE"

echo
echo "==> Step 6: verify — list available skills"
aws agent-toolkit list-available-skills --region "$TOOLKIT_REGION" --profile "$PROFILE"

echo
echo "Done. Restart your AI tool. First prompt to try:"
echo "  Please make a single page webapp game and deploy it to AWS."
