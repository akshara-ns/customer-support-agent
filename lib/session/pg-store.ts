import "server-only";
import { db } from "@/lib/db/client";
import type { EventStore, SessionEvent, StoredEvent } from "@/lib/session/events";
import type { Channel } from "@/lib/types";

interface Row {
  seq: number;
  turn_id: string;
  channel: Channel;
  created_at: string;
  payload: SessionEvent;
}

const toStored = (r: Row): StoredEvent => ({
  seq: r.seq,
  turnId: r.turn_id,
  channel: r.channel,
  createdAt: new Date(r.created_at).toISOString(),
  event: r.payload,
});

export const pgEventStore: EventStore = {
  async ensureSession(sessionId) {
    await db()`INSERT INTO sessions (id) VALUES (${sessionId}) ON CONFLICT (id) DO NOTHING`;
  },
  async append(sessionId, turnId, channel, event) {
    // seq = next number for this session; the UNIQUE (session_id, seq) constraint catches a race, so retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rows = (await db()`
          INSERT INTO session_events (session_id, seq, type, channel, turn_id, payload)
          SELECT ${sessionId}, coalesce(max(seq), 0) + 1, ${event.type}, ${channel}, ${turnId}, ${JSON.stringify(event)}::jsonb
          FROM session_events WHERE session_id = ${sessionId}
          RETURNING seq, turn_id, channel, created_at, payload`) as Row[];
        return toStored(rows[0]);
      } catch (err) {
        if (attempt === 2 || !(err instanceof Error) || !/duplicate key/.test(err.message)) throw err;
      }
    }
    throw new Error("unreachable");
  },
  async list(sessionId) {
    const rows = (await db()`
      SELECT seq, turn_id, channel, created_at, payload FROM session_events
      WHERE session_id = ${sessionId} ORDER BY seq`) as Row[];
    return rows.map(toStored);
  },
};
