// B1 KB Access Layer — Constitutional Types
// Ref: B1-Interface-Constitution.md
// All types derive from constitutional articles. Do not add fields without amendment.

// §1.2 — Authority Record
export interface AuthorityRecord {
  path: string;
  commitSha: string;
  contentHash: string;
  committedAt: string; // ISO 8601
}

// §1.5 — Provenance
export interface Provenance {
  retrievedAt: string; // ISO 8601
  authorityRecord: AuthorityRecord;
}

// §2.2 — Failure Taxonomy
export type FailureType =
  | 'INVALID_REQUEST'
  | 'AUTH_FAILURE'
  | 'NOT_FOUND'
  | 'TAXONOMY_VIOLATION'
  | 'PROVIDER_UNAVAILABLE'
  | 'AUTHORITY_INCONSISTENT';

// §2.1 — Typed Failure
export interface KbFailure {
  errorType: FailureType;
  message: string;
  path: string;
}

// §2.3 — Fetch Success
export interface KbFetchSuccess {
  content: string;
  authorityRecord: AuthorityRecord;
  provenance: Provenance;
}

// §2.3 — List Success
export interface KbListSuccess {
  paths: string[];
  directory: string;
  provenance: Provenance;
}

// Discriminated union results
export type KbFetchResult =
  | { success: true; data: KbFetchSuccess }
  | { success: false; error: KbFailure };

export type KbListResult =
  | { success: true; data: KbListSuccess }
  | { success: false; error: KbFailure };

// §1.3 — Taxonomy (controlled vocabulary)
export const VALID_TAXONOMY: ReadonlyArray<string> = [
  'context',
  'doctrine',
  'infrastructure',
  'officers',
  'operations',
];

// Provider contract types (§3.2)
export interface ProviderResolveSuccess {
  content: string;
  authorityRecord: AuthorityRecord;
}

export interface ProviderEnumerateSuccess {
  paths: string[];
}

export type ProviderResolveResult =
  | { success: true; data: ProviderResolveSuccess }
  | { success: false; error: KbFailure };

export type ProviderEnumerateResult =
  | { success: true; data: ProviderEnumerateSuccess }
  | { success: false; error: KbFailure };
