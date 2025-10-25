#!/bin/bash

# Get token from .tinyb JSON file
USER_TOKEN=$(jq -r '.token' .tinyb)

if [ -z "$USER_TOKEN" ] || [ "$USER_TOKEN" = "null" ]; then
    echo "Error: Could not find token in .tinyb file"
    exit 1
fi

# Get host from .tinyb JSON file
HOST=$(jq -r '.host' .tinyb)
echo "TINYBIRD_API_URL=$HOST"

if [ -z "$HOST" ] || [ "$HOST" = "null" ]; then
    echo "Error: Could not find host in .tinyb file"
    exit 1
fi

# Get id from .tinyb JSON file
WORKSPACE_ID=$(jq -r '.id' .tinyb)
echo "TINYBIRD_WORKSPACE_ID=$WORKSPACE_ID"

if [ -z "$WORKSPACE_ID" ] || [ "$WORKSPACE_ID" = "null" ]; then
    echo "Error: Could not find id in .tinyb file"
    exit 1
fi

# Make GET request to tokens endpoint and parse response
RESPONSE=$(curl -s -X GET \
  "$HOST/v0/tokens" \
  -H "Authorization: Bearer $USER_TOKEN")

# Parse tokens from response
ADMIN_TOKEN=$(echo "$RESPONSE" | jq -r '.tokens[] | select(.name == "workspace admin token") | .token')
TRACKER_TOKEN=$(echo "$RESPONSE" | jq -r '.tokens[] | select(.name == "tracker") | .token')

# Echo the tokens as proof of concept
echo "TINYBIRD_ADMIN_TOKEN=$ADMIN_TOKEN"
echo "TINYBIRD_TRACKER_TOKEN=$TRACKER_TOKEN"
