// Event shapes the console handles beyond the SDK's own union: newer Controllers send inbox.changed and
// service.phase on the fleet-wide stream (older ones don't, and the console polls instead).
import type { A12sEvent, EventEnvelope, InboxSummary, Phase, Failure, Change, CredentialInfo, Token } from "@coltonkirsten/a12s";

type Ev<T extends string, D> = Omit<EventEnvelope, "type" | "data"> & { type: T; data: D };

export type InboxChangedEvent = Ev<"inbox.changed", InboxSummary>;
export type ServicePhaseEvent = Ev<"service.phase", { service: string; phase: Phase; health?: string; restarts?: number; error?: Failure }>;

/** An event as the console keeps it: arrival order id, arrival time, and how many text.deltas it folds. */
export type ConsoleEvent = (A12sEvent | InboxChangedEvent | ServicePhaseEvent) & { _id: number; _at: number; _count?: number };

/** A change list entry; `diff` (before → after per field) is there on Controllers that send it. */
export type ChangeWithDiff = Change & { diff?: Array<{ path: string; before?: unknown; after?: unknown }> };

export type CredentialRow = CredentialInfo & { updatedAt?: string };
export type TokenRow = Token & { lastUsedAt?: string };
