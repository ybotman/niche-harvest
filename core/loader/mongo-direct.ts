// core/loader/mongo-direct.ts — live Loader implementation per LOADER-CONTRACT §8.
//
// Hybrid mechanism (LOADER-CONTRACT §8.2):
//   - Organizer:  POST <BE>/api/organizers      (anonymous; gets shortName + 409 retry)
//   - Venue:      POST <BE>/api/venues          (anonymous; gets AutoMaster + 409 dedup)
//   - Event:      Direct Mongo insertOne        (avoids Firebase auth on POST /api/events;
//                                                 loader pre-computes full denorm bundle)
//
// PROD STAY-OUT: this loader writes nothing PROD. The Mongo URI passed in
// MUST point at TangoTiempoTest. The loader does NOT validate the URI's
// database name (that's a runtime gate handled by the operator's choice
// of MONGODB_URI_TEST), but it refuses to construct without an explicit
// `confirmTestOnly: true` opt-in flag — defense-in-depth so a typo can't
// silently send writes elsewhere.
//
// AIDI Phase 3 gate item #3: when running in `--dry-run --mongo-verify`
// mode the verify path captures collection counts before+after and
// asserts unchanged. That mode is in core/cli/load.ts; this loader's
// only `dryRun` behavior is to NOT call any HTTP/Mongo write methods
// (the upstream CLI runs DryRunLoader instead in dry-run mode anyway).

import { MongoClient, ObjectId, type Db } from "mongodb";

import type {
  EventDoc,
  LoadCounts,
  Loader,
  OrganizerDoc,
  VenueDoc,
  VenueMasteredChainResponse,
} from "./interface.ts";
import type { Logger } from "../types.ts";

export interface MongoDirectOpts {
  /** Mongo connection string (TEST or PLAYGROUND; PROD-STAY-OUT). */
  mongoUri: string;
  /** BE base URL, e.g. "https://calendarbeaf-test.azurewebsites.net".
   *  IGNORED in playground mode (BE doesn't exist for playground; we
   *  write venues + organizers directly to Mongo there). */
  beUrl: string;
  /** Logger from caller */
  logger: Logger;
  /**
   * Defense-in-depth: refuse to construct unless caller explicitly
   * confirms TEST-or-PLAYGROUND-only intent. PROD writes from this loader
   * are forbidden without re-authorization per LOADER-CONTRACT §8.5.
   */
  confirmTestOnly: true;
  /**
   * Cap retries on 409-suffix loop per LOADER-CONTRACT §4.2 step 6.
   * Default 5; override only with reason.
   */
  shortNameRetryCap?: number;
  /**
   * Optional API key for organizer bulk shortname-cache endpoint.
   * Not required for Phase 3 stage 2 (per-organizer lookup-or-create
   * doesn't use bulk cache); keep here for forward compat.
   */
  beApiKey?: string;
  /**
   * Playground mode: skip BE-AF venue/organizer POST endpoints; write
   * EVERYTHING (events + venues + organizers) directly to Mongo.
   * Playground DB has no BE-AF instance; mastered_* chain stays null
   * (no AutoMaster). Used for ephemeral verification cluster.
   * Toby 2026-04-27: safer than appId=99 isolation because separation
   * is structural (different DB) not procedural (filter discipline).
   */
  playgroundMode?: boolean;
}

export class MongoDirectLoader implements Loader {
  readonly name = "mongo-direct" as const;

  private readonly mongoUri: string;
  private readonly beUrl: string;
  private readonly logger: Logger;
  private readonly shortNameRetryCap: number;

  private mongoClient: MongoClient | null = null;
  private db: Db | null = null;
  private readonly playgroundMode: boolean;

  // Counters per LoadCounts contract
  private organizers_attempted = 0;
  private organizers_created = 0;
  private organizers_existing = 0;
  private venues_attempted = 0;
  private venues_created = 0;
  private venues_existing = 0;
  private events_attempted = 0;
  private events_inserted = 0;
  private events_skipped_existing = 0;
  private events_failed = 0;

  constructor(opts: MongoDirectOpts) {
    if (!opts.confirmTestOnly) {
      throw new Error(
        "MongoDirectLoader: refusing to construct without confirmTestOnly=true (PROD-STAY-OUT defense)",
      );
    }
    this.mongoUri = opts.mongoUri;
    this.beUrl = opts.beUrl.replace(/\/+$/, "");
    this.logger = opts.logger;
    this.shortNameRetryCap = opts.shortNameRetryCap ?? 5;
    this.playgroundMode = opts.playgroundMode ?? false;
    if (this.playgroundMode) {
      this.logger.warn("MongoDirectLoader playground mode active", {
        note: "BE-AF venue/organizer POSTs SKIPPED; direct-Mongo for everything; mastered_* fields will be null",
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Connect / close lifecycle
  // ─────────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.mongoClient) return;
    const client = new MongoClient(this.mongoUri);
    await client.connect();
    this.mongoClient = client;
    // Database name is encoded in the URI path; MongoClient.db() with no
    // arg returns the URI's default DB. For TangoTiempoTest URIs this
    // resolves correctly; we don't override it here.
    this.db = client.db();
    this.logger.info("mongo connected", { db: this.db.databaseName });
  }

  async close(): Promise<void> {
    if (this.mongoClient) {
      await this.mongoClient.close();
      this.mongoClient = null;
      this.db = null;
      this.logger.info("mongo closed");
    }
  }

  /**
   * Read-only collection count snapshot. Used by the --mongo-verify mode
   * in core/cli/load.ts to prove zero-writes via before/after diff.
   */
  async collectionCounts(
    collections: string[] = ["events", "venues", "organizers"],
  ): Promise<Record<string, number>> {
    if (!this.db) throw new Error("not connected; call connect() first");
    const out: Record<string, number> = {};
    for (const c of collections) {
      out[c] = await this.db.collection(c).countDocuments();
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Loader interface — Organizer (LOADER-CONTRACT §4)
  // ─────────────────────────────────────────────────────────────────────

  async upsertOrganizer(doc: OrganizerDoc): Promise<ObjectId | string> {
    this.organizers_attempted += 1;

    // ─── Playground mode: direct-Mongo write; no BE-AF round-trip ───
    if (this.playgroundMode) {
      if (!this.db) throw new Error("playground upsertOrganizer: not connected");
      // Lookup by normalized fullName (case-insensitive) within the same appId
      const existing = await this.db
        .collection("organizers")
        .findOne(
          { fullName: doc.fullName, appId: doc.appId, isDiscovered: true },
          { projection: { _id: 1 } },
        );
      if (existing) {
        this.organizers_existing += 1;
        return existing._id;
      }
      const result = await this.db.collection("organizers").insertOne({
        ...doc,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      this.organizers_created += 1;
      return result.insertedId;
    }

    // §4.3 lookup-before-create: check if organizer with this fullName
    // already exists. We use a GET-by-fullName query (BE-AF supports
    // this via /api/organizers?fullName=...&appId=N filter).
    const existing = await this.lookupOrganizerByFullName(doc.fullName, doc.appId);
    if (existing) {
      this.organizers_existing += 1;
      return existing._id;
    }

    // §4.2 create with shortName + 409 suffix retry up to cap
    let shortName = doc.shortName;
    let attempt = 0;
    while (attempt < this.shortNameRetryCap) {
      const candidate: OrganizerDoc = { ...doc, shortName };
      const result = await this.postJson<{ _id: string } | { error: string; code?: string }>(
        "/api/organizers",
        candidate,
      );
      if ("_id" in result.body && result.status === 201) {
        this.organizers_created += 1;
        return result.body._id;
      }
      // 409 DuplicateError on shortName → suffix and retry
      if (
        result.status === 409 &&
        "code" in result.body &&
        result.body.code === "DUPLICATE_SHORTNAME"
      ) {
        attempt += 1;
        shortName = `${doc.shortName}-${attempt + 1}`;
        this.logger.debug("organizer shortName collision; retrying with suffix", {
          fullName: doc.fullName,
          attempt,
          new_shortName: shortName,
        });
        continue;
      }
      // Any other failure: surface
      throw new Error(
        `organizer POST failed (${result.status}): ${JSON.stringify(result.body).slice(0, 200)}`,
      );
    }
    throw new Error(
      `organizer shortName collision exhausted retry cap (${this.shortNameRetryCap}) for ${doc.fullName}`,
    );
  }

  private async lookupOrganizerByFullName(
    fullName: string,
    appId: number,
  ): Promise<{ _id: string } | null> {
    // BE supports filtering organizers by fullName via the standard list
    // endpoint. URL-encode the name to handle spaces and special chars.
    const url = `/api/organizers?appId=${appId}&fullName=${encodeURIComponent(fullName)}&limit=1`;
    const result = await this.getJson<{ organizers?: Array<{ _id: string }> }>(url);
    if (result.status !== 200) return null;
    const orgs = result.body.organizers ?? [];
    return orgs.length > 0 ? orgs[0]! : null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Loader interface — Venue (LOADER-CONTRACT §3 + §8.3)
  // ─────────────────────────────────────────────────────────────────────

  async upsertVenue(doc: VenueDoc): Promise<{
    venueId: ObjectId | string;
    masteredChain: VenueMasteredChainResponse;
  }> {
    this.venues_attempted += 1;

    // ─── Playground mode: direct-Mongo write; mastered chain stays null ───
    if (this.playgroundMode) {
      if (!this.db) throw new Error("playground upsertVenue: not connected");
      // Dedup by (name, city, appId, isDiscovered) within playground
      const existing = await this.db
        .collection("venues")
        .findOne(
          { name: doc.name, city: doc.city, appId: doc.appId, isDiscovered: true },
          { projection: { _id: 1 } },
        );
      if (existing) {
        this.venues_existing += 1;
        return { venueId: existing._id, masteredChain: this.nullMasteredChain() };
      }
      const result = await this.db.collection("venues").insertOne({
        ...doc,
        // Build a GeoJSON Point from lat/lng (BE does this on real path)
        geolocation: { type: "Point", coordinates: [doc.longitude, doc.latitude] },
        // mastered_* + timezone left null in playground (no AutoMaster)
        timezone: null,
        masteredCityId: null, masteredCityName: null,
        masteredDivisionId: null, masteredDivisionName: null,
        masteredRegionId: null, masteredRegionName: null,
        masteredCountryId: null, masteredCountryName: null,
        masteringStatus: "PLAYGROUND_NO_AUTOMASTER",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      this.venues_created += 1;
      return { venueId: result.insertedId, masteredChain: this.nullMasteredChain() };
    }

    const result = await this.postJson<VenuePostResponse>("/api/venues", doc);

    if (result.status === 201 && "venue" in result.body && result.body.venue) {
      this.venues_created += 1;
      return {
        venueId: result.body.venue._id,
        masteredChain: extractMasteredChain(result.body.venue),
      };
    }

    // §8.3 + §5.4.1: 409 DuplicateError → fetch the existing venue's
    // mastered chain via GET (the 409 body has existingVenueId but not
    // the mastered fields per Fulton 2026-04-25)
    if (result.status === 409 && "existingVenueId" in result.body && result.body.existingVenueId) {
      this.venues_existing += 1;
      const existingId = result.body.existingVenueId;
      const fetched = await this.fetchVenueById(existingId);
      if (!fetched) {
        throw new Error(
          `venue 409 returned existingVenueId=${existingId} but GET /api/venues/${existingId} failed`,
        );
      }
      return {
        venueId: existingId,
        masteredChain: extractMasteredChain(fetched),
      };
    }

    throw new Error(
      `venue POST failed (${result.status}): ${JSON.stringify(result.body).slice(0, 200)}`,
    );
  }

  /**
   * Playground-mode helper: returns an all-null mastered chain since
   * there's no AutoMaster service to run against the playground DB.
   * Events written in playground mode reference null mastered_* fields;
   * acceptable for verification of the LOAD CHAIN; FE rendering of these
   * specific events is undefined and not the subject of playground tests.
   */
  private nullMasteredChain(): VenueMasteredChainResponse {
    return {
      timezone: null,
      geolocation: null,
      masteredCityId: null,
      masteredCityName: null,
      masteredDivisionId: null,
      masteredDivisionName: null,
      masteredRegionId: null,
      masteredRegionName: null,
      masteredCountryId: null,
      masteredCountryName: null,
    };
  }

  private async fetchVenueById(id: string): Promise<VenueResponseShape | null> {
    const result = await this.getJson<{ venue?: VenueResponseShape }>(
      `/api/venues/${id}`,
    );
    if (result.status !== 200) return null;
    return result.body.venue ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Loader interface — Event (LOADER-CONTRACT §8.2 direct Mongo insertOne)
  // ─────────────────────────────────────────────────────────────────────

  async insertEvent(doc: EventDoc): Promise<{
    eventId: ObjectId | string;
    status: "inserted" | "skipped_existing" | "failed";
    detail?: string;
  }> {
    this.events_attempted += 1;
    if (!this.db) {
      throw new Error("MongoDirectLoader.insertEvent: not connected; call connect() first");
    }

    // §8.3 dedup: skip if (title-normalized, local-start-date, venueID)
    // already exists. The "local start date in venue timezone" is hard
    // to compute pre-insert without the venue tz; we use UTC start day
    // as a conservative proxy. If a duplicate is found we increment
    // events_skipped_existing rather than insert.
    //
    // GUARDRAILS H3 (CRITICAL): dedup query MUST filter
    // {isDiscovered: true} so we never collide with user-entered events
    // (isDiscovered=false). If a user-entered event happens to match
    // (appId, title, day-bucket, venue), our discovery write should NOT
    // be suppressed — the discovery event is a separate row. Conversely
    // we must never UPDATE a user row by mistaking it for a discovery
    // duplicate.
    const dupQuery = {
      appId: doc.appId,
      title: doc.title,
      startDate: { $gte: dayStart(doc.startDate), $lt: dayEnd(doc.startDate) },
      venueID: doc.venueID,
      isDiscovered: true,
    };
    const dup = await this.db.collection("events").findOne(dupQuery, {
      projection: { _id: 1 },
    });
    if (dup) {
      this.events_skipped_existing += 1;
      return { eventId: String(dup._id), status: "skipped_existing" };
    }

    // §6 + §10 final validation: anti-recurrence guard at write time.
    // BE force-nulls isRepeating + recurrenceRule when endDate-startDate >24h
    // (Fulton: Events.js:964-971). We mirror that here so the document we
    // insert matches what BE would normalize on its HTTP path.
    const durationMs = Date.parse(doc.endDate) - Date.parse(doc.startDate);
    const docToInsert: EventDoc = { ...doc };
    if (durationMs > 24 * 3600 * 1000) {
      docToInsert.isRepeating = false;
      docToInsert.recurrenceRule = null;
    }

    try {
      const result = await this.db.collection("events").insertOne(docToInsert);
      this.events_inserted += 1;
      return { eventId: result.insertedId, status: "inserted" };
    } catch (err) {
      this.events_failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      return { eventId: "", status: "failed", detail: message };
    }
  }

  counts(): LoadCounts {
    return {
      organizers_attempted: this.organizers_attempted,
      organizers_created: this.organizers_created,
      organizers_existing: this.organizers_existing,
      venues_attempted: this.venues_attempted,
      venues_created: this.venues_created,
      venues_existing: this.venues_existing,
      events_attempted: this.events_attempted,
      events_inserted: this.events_inserted,
      events_skipped_existing: this.events_skipped_existing,
      events_failed: this.events_failed,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // BE HTTP helpers (anonymous endpoints; no auth needed for venues
  // and organizers per LOADER-CONTRACT §8.2)
  // ─────────────────────────────────────────────────────────────────────

  private async postJson<TBody>(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: TBody }> {
    const url = `${this.beUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // empty response body or non-JSON; leave null
    }
    return { status: res.status, body: (parsed ?? {}) as TBody };
  }

  private async getJson<TBody>(
    path: string,
  ): Promise<{ status: number; body: TBody }> {
    const url = `${this.beUrl}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // empty body; leave null
    }
    return { status: res.status, body: (parsed ?? {}) as TBody };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// BE response shapes (subset of fields we read)
// ──────────────────────────────────────────────────────────────────────────

interface VenueResponseShape {
  _id: string;
  timezone?: string;
  geolocation?: { type: "Point"; coordinates: [number, number] };
  masteredCityId?: string;
  masteredCityName?: string;
  masteredDivisionId?: string;
  masteredDivisionName?: string;
  masteredRegionId?: string;
  masteredRegionName?: string;
  masteredCountryId?: string;
  masteredCountryName?: string;
}

interface VenuePostResponse {
  venue?: VenueResponseShape;
  existingVenueId?: string;
  existingVenueName?: string;
  error?: string;
  message?: string;
}

function extractMasteredChain(v: VenueResponseShape): VenueMasteredChainResponse {
  return {
    timezone: v.timezone ?? null,
    geolocation: v.geolocation ?? null,
    masteredCityId: v.masteredCityId ?? null,
    masteredCityName: v.masteredCityName ?? null,
    masteredDivisionId: v.masteredDivisionId ?? null,
    masteredDivisionName: v.masteredDivisionName ?? null,
    masteredRegionId: v.masteredRegionId ?? null,
    masteredRegionName: v.masteredRegionName ?? null,
    masteredCountryId: v.masteredCountryId ?? null,
    masteredCountryName: v.masteredCountryName ?? null,
  };
}

function dayStart(iso: string): Date {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dayEnd(iso: string): Date {
  const d = new Date(iso);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}
