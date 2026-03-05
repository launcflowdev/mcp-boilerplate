// B1 KB Access Layer — Access Interface (Article II)
// The Access Interface answers: "May I have this document?"
// Enforces taxonomy, validates input, wraps provider with provenance.

import type {
  KbFetchResult,
  KbListResult,
  KbFailure,
  Provenance,
} from './types';
import { VALID_TAXONOMY } from './types';
import * as provider from './provider';

interface AccessConfig {
  pat: string;
  owner: string;
  repo: string;
}

function failure(errorType: KbFailure['errorType'], message: string, path: string): KbFailure {
  return { errorType, message, path };
}

// §1.3 — Validate path starts with a valid taxonomy directory
function validateTaxonomy(inputPath: string): KbFailure | null {
  // Extract the top-level directory from the path
  const normalized = inputPath.replace(/^\/+/, ''); // strip leading slashes
  const topDir = normalized.split('/')[0];

  if (!topDir) {
    return failure('INVALID_REQUEST', 'Empty path after normalization', inputPath);
  }

  if (!VALID_TAXONOMY.includes(topDir)) {
    return failure(
      'TAXONOMY_VIOLATION',
      `Path "${inputPath}" is outside the controlled vocabulary. Valid roots: ${VALID_TAXONOMY.join(', ')}`,
      inputPath
    );
  }

  return null; // valid
}

// §2.1 — Validate input is structurally sound
function validateInput(inputPath: unknown): KbFailure | null {
  if (inputPath === null || inputPath === undefined) {
    return failure('INVALID_REQUEST', 'Path is null or undefined', String(inputPath));
  }
  if (typeof inputPath !== 'string') {
    return failure('INVALID_REQUEST', `Path must be a string, got ${typeof inputPath}`, String(inputPath));
  }
  if (inputPath.trim().length === 0) {
    return failure('INVALID_REQUEST', 'Path is empty', inputPath);
  }
  return null;
}

// Normalize path — strip leading slashes, collapse doubles
function normalizePath(inputPath: string): string {
  return inputPath.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');
}

// Build provenance with retrieval timestamp
function buildProvenance(authorityRecord: Provenance['authorityRecord']): Provenance {
  return {
    retrievedAt: new Date().toISOString(),
    authorityRecord,
  };
}

// §2.3 — fetch(path) → document + authority record + provenance, or typed failure
export async function kbFetch(config: AccessConfig, inputPath: string): Promise<KbFetchResult> {
  // Validate input
  const inputError = validateInput(inputPath);
  if (inputError) return { success: false, error: inputError };

  const normalized = normalizePath(inputPath);

  // Validate taxonomy
  const taxError = validateTaxonomy(normalized);
  if (taxError) return { success: false, error: taxError };

  // Delegate to provider
  const result = await provider.resolve(config, normalized);

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // §1.5 — Attach provenance
  const provenance = buildProvenance(result.data.authorityRecord);

  return {
    success: true,
    data: {
      content: result.data.content,
      authorityRecord: result.data.authorityRecord,
      provenance,
    },
  };
}

// §2.3 — list(directory) → paths + provenance, or typed failure
export async function kbList(config: AccessConfig, directory: string): Promise<KbListResult> {
  // Validate input
  const inputError = validateInput(directory);
  if (inputError) return { success: false, error: inputError };

  const normalized = normalizePath(directory);

  // Validate taxonomy
  const taxError = validateTaxonomy(normalized);
  if (taxError) return { success: false, error: taxError };

  // Delegate to provider
  const result = await provider.enumerate(config, normalized);

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // For list, provenance uses a minimal authority record (no single-file commit)
  const provenance: Provenance = {
    retrievedAt: new Date().toISOString(),
    authorityRecord: {
      path: normalized,
      commitSha: 'N/A — directory listing',
      contentHash: 'N/A — directory listing',
      committedAt: 'N/A — directory listing',
    },
  };

  return {
    success: true,
    data: {
      paths: result.data.paths,
      directory: normalized,
      provenance,
    },
  };
}
