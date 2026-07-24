#!/usr/bin/env bash
set -euo pipefail

user_name="$(id -un)"
user_id="$(id -u)"
user_home="$(/usr/bin/dscl . -read "/Users/$user_name" NFSHomeDirectory | /usr/bin/awk '{print $2}')"
launch_agents_dir="$user_home/Library/LaunchAgents"
launch_domain="gui/$user_id"

# Remove only the two exact runtime definitions. Product data, private config,
# access credentials and logs are intentionally preserved for recovery.
launchctl bootout "$launch_domain/com.later.chat.cloud-relay" 2>/dev/null || true
launchctl bootout "$launch_domain/com.later.chat.backend" 2>/dev/null || true
rm -f \
  "$launch_agents_dir/com.later.chat.cloud-relay.plist" \
  "$launch_agents_dir/com.later.chat.backend.plist"

echo "Chat mobile relay LaunchAgents were removed; Product data and logs were preserved."
