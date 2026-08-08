"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { GameSession, RoundMode, VersusMode } from "@/lib/rating-types";

const ROUND_MODE_LABELS: Record<RoundMode, string> = {
  rotation: "Rotation",
  rating: "Rating",
  strictRotationBestMatch: "Strict rotation (best match)",
};

const VERSUS_MODE_LABELS: Record<VersusMode, string> = {
  doubles: "Doubles",
  singles: "Singles",
};

type SessionMatch = {
  id: string;
  team_a: string[];
  team_b: string[];
  winner: "A" | "B";
  created_at: string;
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);

  if (!response.ok) {
    let message = `Request to ${path} failed (${response.status}).`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      // ignore parse failure, keep the default message
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

function formatSessionRange(session: GameSession): string {
  const started = new Date(session.startedAt);
  const startedLabel = started.toLocaleString();
  if (!session.endedAt) return startedLabel;
  const ended = new Date(session.endedAt);
  const sameDay = started.toDateString() === ended.toDateString();
  return `${startedLabel} – ${sameDay ? ended.toLocaleTimeString() : ended.toLocaleString()}`;
}

export default function HistoryPage() {
  const [sessions, setSessions] = useState<GameSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [matchesBySession, setMatchesBySession] = useState<Record<string, SessionMatch[]>>({});
  const [loadingMatchesFor, setLoadingMatchesFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJson<{ sessions: GameSession[] }>("/api/history/sessions")
      .then((data) => {
        if (!cancelled) setSessions(data.sessions);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load session history.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSession = async (sessionId: string) => {
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null);
      return;
    }
    setExpandedSessionId(sessionId);
    if (matchesBySession[sessionId]) return;

    setLoadingMatchesFor(sessionId);
    try {
      const data = await getJson<{ matches: SessionMatch[] }>(`/api/history/sessions/${sessionId}/matches`);
      setMatchesBySession((prev) => ({ ...prev, [sessionId]: data.matches }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load matches for session.");
    } finally {
      setLoadingMatchesFor(null);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold">Session history</h1>
              <p className="mt-2 max-w-2xl text-sm text-zinc-400">
                Past sessions, most recent first. Click a session to see its matches.
              </p>
            </div>
            <Link
              href="/"
              className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium hover:bg-zinc-800"
            >
              Back to queue
            </Link>
          </div>
          {error ? (
            <p className="mt-4 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</p>
          ) : null}
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          {sessions === null ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-zinc-500">No past sessions yet — sessions appear here once you Start and Stop one.</p>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => {
                const isExpanded = expandedSessionId === session.id;
                const matches = matchesBySession[session.id];
                return (
                  <div key={session.id} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                    <button
                      onClick={() => toggleSession(session.id)}
                      className="flex w-full items-center justify-between gap-4 text-left"
                    >
                      <div>
                        <p className="font-medium">{formatSessionRange(session)}</p>
                        <p className="mt-1 text-xs text-zinc-500">
                          {ROUND_MODE_LABELS[session.roundMode]} • {VERSUS_MODE_LABELS[session.versusMode]} •{" "}
                          {session.courtsAvailable} court{session.courtsAvailable === 1 ? "" : "s"}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-zinc-500">{isExpanded ? "Hide matches" : "View matches"}</span>
                    </button>

                    {isExpanded ? (
                      <div className="mt-3 space-y-2 border-t border-zinc-800 pt-3">
                        {loadingMatchesFor === session.id ? (
                          <p className="text-xs text-zinc-500">Loading matches…</p>
                        ) : !matches || matches.length === 0 ? (
                          <p className="text-xs text-zinc-500">No matches recorded in this session.</p>
                        ) : (
                          matches.map((match) => (
                            <div key={match.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-sm">
                              <span className={match.winner === "A" ? "font-semibold text-cyan-400" : "text-zinc-300"}>
                                {match.team_a.join(" & ")}
                              </span>
                              <span className="mx-2 text-zinc-600">vs</span>
                              <span className={match.winner === "B" ? "font-semibold text-cyan-400" : "text-zinc-300"}>
                                {match.team_b.join(" & ")}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
