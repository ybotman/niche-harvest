// core/loader/dry-run.ts — DryRunLoader implementation.
//
// Implements the Loader interface but writes nothing. Each upsert/insert
// captures the document that WOULD be written; counts() returns the
// would-have counts. Caller serializes the captured docs into the dry-run
// JSON report.
//
// Authority: ARCHITECTURE.md §2; LOADER-CONTRACT.md §6/§8 (the contract
// the captured docs honor). AIDI 2026-04-25 review: every §6 field must
// be present in the captured event docs even if mastered chain values
// are TODO:automaster sentinels.

import type { ObjectId } from "mongodb";
import type {
  EventDoc,
  LoadCounts,
  Loader,
  OrganizerDoc,
  VenueDoc,
  VenueMasteredChainResponse,
} from "./interface.ts";
import { stubMasteredChain } from "./denorm.ts";

export interface CapturedOrganizer {
  doc: OrganizerDoc;
  resolvedId: string; // dryrun-organizer-<n>
  decision: "would_create" | "would_use_existing";
}

export interface CapturedVenue {
  doc: VenueDoc;
  resolvedId: string; // dryrun-venue-<n>
  decision: "would_create" | "would_use_existing";
  masteredChain: VenueMasteredChainResponse;
}

export interface CapturedEvent {
  doc: EventDoc;
  resolvedId: string; // dryrun-event-<n>
  decision: "would_insert" | "would_skip_existing" | "would_fail";
  detail?: string;
}

export class DryRunLoader implements Loader {
  readonly name = "dry-run" as const;

  readonly capturedOrganizers: CapturedOrganizer[] = [];
  readonly capturedVenues: CapturedVenue[] = [];
  readonly capturedEvents: CapturedEvent[] = [];

  private organizerIdSeq = 0;
  private venueIdSeq = 0;
  private eventIdSeq = 0;

  // De-dup by fullName so multi-event-per-organizer doesn't inflate counts
  private organizerByName = new Map<string, string>();
  // De-dup by venue name+city
  private venueByKey = new Map<string, { id: string; chain: VenueMasteredChainResponse }>();

  upsertOrganizer(doc: OrganizerDoc): Promise<ObjectId | string> {
    const key = doc.fullName.trim().toLowerCase();
    const existing = this.organizerByName.get(key);
    if (existing) {
      this.capturedOrganizers.push({
        doc,
        resolvedId: existing,
        decision: "would_use_existing",
      });
      return Promise.resolve(existing);
    }
    this.organizerIdSeq += 1;
    const newId = `dryrun-organizer-${this.organizerIdSeq}`;
    this.organizerByName.set(key, newId);
    this.capturedOrganizers.push({
      doc,
      resolvedId: newId,
      decision: "would_create",
    });
    return Promise.resolve(newId);
  }

  upsertVenue(doc: VenueDoc): Promise<{
    venueId: ObjectId | string;
    masteredChain: VenueMasteredChainResponse;
  }> {
    const key = `${doc.name.trim().toLowerCase()}|${(doc.city ?? "").trim().toLowerCase()}`;
    const existing = this.venueByKey.get(key);
    if (existing) {
      this.capturedVenues.push({
        doc,
        resolvedId: existing.id,
        decision: "would_use_existing",
        masteredChain: existing.chain,
      });
      return Promise.resolve({ venueId: existing.id, masteredChain: existing.chain });
    }
    this.venueIdSeq += 1;
    const newId = `dryrun-venue-${this.venueIdSeq}`;
    const chain = stubMasteredChain();
    this.venueByKey.set(key, { id: newId, chain });
    this.capturedVenues.push({
      doc,
      resolvedId: newId,
      decision: "would_create",
      masteredChain: chain,
    });
    return Promise.resolve({ venueId: newId, masteredChain: chain });
  }

  insertEvent(doc: EventDoc): Promise<{
    eventId: ObjectId | string;
    status: "inserted" | "skipped_existing" | "failed";
    detail?: string;
  }> {
    this.eventIdSeq += 1;
    const newId = `dryrun-event-${this.eventIdSeq}`;
    this.capturedEvents.push({
      doc,
      resolvedId: newId,
      decision: "would_insert",
    });
    return Promise.resolve({ eventId: newId, status: "inserted" });
  }

  counts(): LoadCounts {
    return {
      organizers_attempted: this.capturedOrganizers.length,
      organizers_created: this.capturedOrganizers.filter(
        (o) => o.decision === "would_create",
      ).length,
      organizers_existing: this.capturedOrganizers.filter(
        (o) => o.decision === "would_use_existing",
      ).length,
      venues_attempted: this.capturedVenues.length,
      venues_created: this.capturedVenues.filter(
        (v) => v.decision === "would_create",
      ).length,
      venues_existing: this.capturedVenues.filter(
        (v) => v.decision === "would_use_existing",
      ).length,
      events_attempted: this.capturedEvents.length,
      events_inserted: this.capturedEvents.filter(
        (e) => e.decision === "would_insert",
      ).length,
      events_skipped_existing: this.capturedEvents.filter(
        (e) => e.decision === "would_skip_existing",
      ).length,
      events_failed: this.capturedEvents.filter(
        (e) => e.decision === "would_fail",
      ).length,
    };
  }
}
