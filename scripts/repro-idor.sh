#!/usr/bin/env bash
# Reproduction for review finding S1 (session IDOR): client A writes to a session; client B (no shared
# cookies) reads it and mints a voice key for it. Expected after the fix: B gets 403 everywhere, A still 200.
# Usage: scripts/repro-idor.sh [base-url]   (no LLM cost: voice events + one voice-key mint)
set -u
U="${1:-https://customer-support-agent-sable-two.vercel.app}"
SID=$(uuidgen | tr 'A-Z' 'a-z')
TURN=$(uuidgen | tr 'A-Z' 'a-z')
JAR_A=$(mktemp); JAR_B=$(mktemp)

echo "session $SID"
echo -n "A writes transcript:        "
curl -s -o /dev/null -w "%{http_code}\n" -c "$JAR_A" -b "$JAR_A" -X POST "$U/api/voice/events" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"turnId\":\"$TURN\",\"event\":{\"kind\":\"user_transcript\",\"text\":\"secret question from A\"}}"
echo -n "A reads own transcript:     "
curl -s -w " %{http_code}\n" -c "$JAR_A" -b "$JAR_A" "$U/api/chat?sessionId=$SID" | cut -c1-120
echo -n "B reads A's transcript:     "
curl -s -w " %{http_code}\n" -c "$JAR_B" -b "$JAR_B" "$U/api/chat?sessionId=$SID" | cut -c1-120
echo -n "B reads A's traces:         "
curl -s -o /dev/null -w "%{http_code}\n" -c "$JAR_B" -b "$JAR_B" "$U/api/sessions/$SID/traces"
echo -n "B writes into A's session:  "
curl -s -o /dev/null -w "%{http_code}\n" -c "$JAR_B" -b "$JAR_B" -X POST "$U/api/voice/events" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"turnId\":\"$TURN\",\"event\":{\"kind\":\"user_transcript\",\"text\":\"injected by B\"}}"
echo -n "B mints voice key for A:    "
curl -s -o /dev/null -w "%{http_code}\n" -c "$JAR_B" -b "$JAR_B" -X POST "$U/api/voice/session" -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID\"}"
rm -f "$JAR_A" "$JAR_B"
