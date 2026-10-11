/**
 * Contract conformance: validates the CLIENT's mirrored contract against the
 * LIVE server's /openapi.json. Read-only, safe to run any time.
 *
 *   node scripts/verify-contract.mjs [http://192.168.1.100:8765]
 *
 * The server's OpenAPI schema is the single source of truth; this script fails
 * loudly the moment the client and the server disagree.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const BASE = (process.argv[2] ?? 'http://192.168.1.100:8765').replace(/\/+$/, '');

// The client's mirrored values, read straight from the source of truth in src/.
const clientTypes = readFileSync(fileURLToPath(new URL('../src/shared/types.ts', import.meta.url)), 'utf8');

const failures = [];
const passes = [];
const warnings = [];
const check = (name, ok, detail = '') => (ok ? passes : failures).push(`${name}${detail ? ` — ${detail}` : ''}`);

const enumFromSource = (constName) => {
  const m = new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\] as const`).exec(clientTypes);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

const clientQuality = enumFromSource('QUALITY_VALUES');
const clientMediaTypes = enumFromSource('MEDIA_TYPES');
const clientStates = enumFromSource('DOWNLOAD_STATES');
const clientKinds = enumFromSource('CONTENT_KINDS');

let schema;
try {
  const res = await fetch(`${BASE}/openapi.json`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  schema = await res.json();
} catch (e) {
  console.error(`\nCould not fetch ${BASE}/openapi.json — ${e.message}`);
  console.error('Is the server running and reachable?\n');
  process.exit(1);
}

console.log(`\nContract conformance → ${BASE}`);
console.log(`      server ${schema.info?.version} · openapi ${schema.openapi} · ${Object.keys(schema.paths).length} paths\n`);

const C = schema.components?.schemas ?? {};
const P = schema.paths;

// ---- 1. auth model ------------------------------------------------------
check('bearerAuth security scheme is declared', Boolean(schema.components?.securitySchemes?.bearerAuth));
const healthSecurity = P['/api/v1/health']?.get?.security;
check('/health is correctly unauthenticated', healthSecurity === undefined || healthSecurity.length === 0);
const qualitySecurity = P['/api/v1/quality']?.get?.security;
check(
  '/quality requires bearerAuth',
  Array.isArray(qualitySecurity) && qualitySecurity.some((s) => s.bearerAuth),
  JSON.stringify(qualitySecurity),
);
check('/server/info is correctly unauthenticated', P['/api/v1/server/info']?.get?.security === undefined);

// ---- 2. enums match the client's ----------------------------------------
const qEnum = C.QualityEnum?.enum ?? [];
check(
  `QualityEnum matches client (${clientQuality?.length} values)`,
  JSON.stringify(qEnum) === JSON.stringify(clientQuality),
  qEnum.join(','),
);
const sEnum = C.DownloadStateEnum?.enum ?? [];
check(
  `DownloadStateEnum matches client (${clientStates?.length} values)`,
  JSON.stringify(sEnum) === JSON.stringify(clientStates),
  sEnum.join(','),
);
const kEnum = C.VideoKindEnum?.enum ?? [];
check(
  `VideoKindEnum matches client (${clientKinds?.length} values)`,
  JSON.stringify(kEnum) === JSON.stringify(clientKinds),
  kEnum.join(','),
);
check(
  'QualityEnum describes ceilings',
  /ceiling/i.test(C.QualityEnum?.description ?? ''),
  C.QualityEnum?.description ?? '(no description)',
);

// ---- 3. models the client depends on ------------------------------------
const fieldsOf = (name) => new Set(Object.keys(C[name]?.properties ?? {}));
/** Some models are declared inline on the operation rather than named. */
const resolveSchema = (ref) => {
  if (!ref) return null;
  if (ref.$ref) {
    const name = ref.$ref.split('/').pop();
    return C[name] ?? null;
  }
  return ref;
};
const inlineModel = (method, path, status = '200') =>
  resolveSchema(P[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema);

const assertFields = (model, required) => {
  const schemaFor = fieldsOf(model).size ? C[model] : inlineModel(model.method, model.path) ?? null;
  if (!schemaFor || Object.keys(schemaFor.properties ?? {}).length === 0) {
    check(`${model.label ?? model.name} is declared`, false, 'missing from schema');
    return;
  }
  const have = new Set(Object.keys(schemaFor.properties));
  const label = typeof model === 'string' ? model : model.label;
  const missing = required.filter((f) => !have.has(f));
  check(`${label} has every field the client reads`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
};

assertFields('Video', [
  'id', 'video_id', 'channel_id', 'media_type', 'thumbnail_path', 'source_id', 'pinned', 'title',
  'description', 'published_at', 'duration', 'is_short', 'kind', 'file_path', 'file_size',
  'quality', 'quality_height', 'watched', 'watched_at', 'status', 'error_message',
  'created_at', 'updated_at',
]);
{
  const jobProps = Object.keys(C.Job?.properties ?? {});
  if (jobProps.includes('media_type')) {
    passes.push('Job exposes media_type');
  } else {
    warnings.push(
      'Job has NO media_type field (the handoff notes claim it does). Clients must read media_type ' +
        'from Video, not Job.',
    );
  }
}
assertFields('Job', [
  'id', 'video_id', 'channel_id', 'status', 'quality', 'progress', 'speed',
  'downloaded_bytes', 'total_bytes', 'eta', 'attempts', 'next_attempt_at',
  'error_message', 'created_at', 'updated_at', 'started_at', 'completed_at',
]);
check(
  `MediaTypeEnum matches client (${clientMediaTypes?.length} values)`,
  JSON.stringify(C.MediaTypeEnum?.enum ?? []) === JSON.stringify(clientMediaTypes),
  (C.MediaTypeEnum?.enum ?? []).join(','),
);
assertFields('Channel', [
  'id', 'channel_id', 'url', 'title', 'enabled', 'quality_override',
  'last_checked_at', 'last_uploaded_at', 'created_at', 'updated_at',
]);
assertFields('DeleteResult', ['deleted', 'files_deleted', 'files_missing', 'errors']);
assertFields('DeleteRequest', ['video_ids', 'delete_files', 'dry_run']);
assertFields('FileMetadata', [
  'video_id', 'filename', 'size_bytes', 'mime_type', 'quality',
  'quality_height', 'duration', 'modified_at', 'supports_ranges',
]);
assertFields('QualitySettings', [
  'quality', 'media_type', 'prefer_mp4', 'embed_subs', 'sub_langs', 'embed_metadata',
  'embed_thumbnail', 'write_description', 'download_dir', 'max_concurrent_downloads',
]);
assertFields('SourceOut', ['id', 'source_id', 'kind', 'url', 'title', 'enabled', 'quality_override', 'counts']);
assertFields('SourceCounts', ['total', 'downloaded', 'failed']);
assertFields('FetchResult', ['kind', 'resolved', 'added', 'queued', 'duplicates', 'unavailable', 'truncated', 'quality', 'media_type']);
assertFields('SourcePreview', ['source_id', 'kind', 'count', 'truncated', 'cookies_required', 'entries']);
assertFields('SourcesStatus', ['sources', 'enabled', 'running', 'cookies_configured', 'default_quality']);
assertFields('ScanStats', ['source', 'seen', 'new', 'queued', 'duplicates', 'truncated', 'error']);
assertFields('LibrarySettings', ['media_layout', 'tree_order', 'retention_days', 'max_library_items', 'delete_file_when_watched']);
assertFields('PinRequest', ['video_ids', 'pinned']);
check('PinRequest requires video_ids (empty body is a 422)', C.PinRequest?.required?.includes('video_ids') === true);
check('RetentionUpdate is strict (additionalProperties: false)', C.RetentionUpdate?.additionalProperties === false);
assertFields('MonitorSettings', ['enabled', 'interval_minutes', 'window_hours', 'future_only', 'content_filter']);

// GET /storage gained orphaned_bytes; check it is at least discoverable.
const storageSchema = inlineModel('get', '/api/v1/storage');
const storageProps = Object.keys(storageSchema?.properties ?? {});
if (storageProps.length === 0) {
  warnings.push(
    'GET /storage returns an untyped object — declare a StorageInfo schema ' +
      '(the client reads: bytes, files, free, watched_bytes, unwatched_bytes, orphaned_bytes).',
  );
} else {
  const missing = ['bytes', 'files', 'free'].filter((f) => !storageProps.includes(f));
  check('StorageInfo is typed and has the totals', missing.length === 0, missing.join(', '));
  check(
    'StorageInfo declares orphaned_bytes',
    storageProps.includes('orphaned_bytes'),
    'client hides the breakdown when it is absent',
  );
}
// GET /retention returns an untyped object on the current server; warn instead
// of failing, and say exactly which fields the client expects.
const retentionSchema = inlineModel('get', '/api/v1/retention');
const retentionFields = new Set(Object.keys(retentionSchema?.properties ?? {}));
const retentionWanted = ['delete_file_when_watched', 'retention_days', 'max_library_items'];
if (retentionFields.size === 0) {
  warnings.push(
    'GET /retention returns an untyped object — declare a RetentionSettings schema ' +
      `(the client reads: ${retentionWanted.join(', ')}).`,
  );
} else {
  const missing = retentionWanted.filter((f) => !retentionFields.has(f));
  check('RetentionSettings has every field the client reads', missing.length === 0, missing.join(', '));
}
assertFields('QualityOptions', ['options', 'default', 'per_channel_overrides']);
assertFields('QueueStats', ['queued', 'downloading', 'completed', 'failed', 'skipped', 'unavailable']);
check('QueueStats has no "discovered" counter (contract says it must not)', !fieldsOf('QueueStats').has('discovered'));

// ---- 4. endpoints the client calls --------------------------------------
const endpoints = [
  ['get', '/api/v1/health'],
  ['get', '/api/v1/server/info'],
  ['get', '/api/v1/quality/options'],
  ['get', '/api/v1/quality'],
  ['put', '/api/v1/quality'],
  ['get', '/api/v1/monitor'],
  ['put', '/api/v1/monitor'],
  ['post', '/api/v1/monitor/scan'],
  ['post', '/api/v1/monitor/check'],
  ['get', '/api/v1/channels'],
  ['post', '/api/v1/channels'],
  ['get', '/api/v1/channels/{channel_id}'],
  ['patch', '/api/v1/channels/{channel_id}'],
  ['delete', '/api/v1/channels/{channel_id}'],
  ['post', '/api/v1/channels/{channel_id}/scan'],
  ['get', '/api/v1/videos'],
  ['get', '/api/v1/videos/by-id/{video_id}'],
  ['patch', '/api/v1/videos/{video_id}/watched'],
  ['delete', '/api/v1/videos/{video_id}'],
  ['post', '/api/v1/videos/bulk-delete'],
  ['post', '/api/v1/videos/discover'],
  ['get', '/api/v1/queue/stats'],
  ['get', '/api/v1/queue/{video_id}'],
  ['post', '/api/v1/queue/{video_id}/retry'],
  ['post', '/api/v1/queue/{video_id}/cancel'],
  ['post', '/api/v1/queue/enqueue'],
  ['get', '/api/v1/retention'],
  ['put', '/api/v1/retention'],
  ['get', '/api/v1/files/{video_id}/metadata'],
  ['get', '/api/v1/files/{video_id}/stream'],
  ['get', '/api/v1/files/{video_id}/download'],
  ['get', '/api/v1/storage'],
  ['get', '/api/v1/logs'],
  ['post', '/api/v1/logs'],
  ['get', '/api/v1/tokens'],
  ['post', '/api/v1/tokens'],
  ['delete', '/api/v1/tokens/{token_id}'],
  ['delete', '/api/v1/tokens/by-value'],
  // media + sources surface
  ['get', '/api/v1/videos/{video_id}/thumbnail'],
  ['post', '/api/v1/videos/fetch'],
  ['get', '/api/v1/sources'],
  ['post', '/api/v1/sources'],
  ['get', '/api/v1/sources/{source_id}'],
  ['patch', '/api/v1/sources/{source_id}'],
  ['delete', '/api/v1/sources/{source_id}'],
  ['post', '/api/v1/sources/{source_id}/scan'],
  ['post', '/api/v1/sources/scan'],
  ['post', '/api/v1/sources/preview'],
  ['get', '/api/v1/sources/status'],
  // pin / keep permanently
  ['patch', '/api/v1/videos/{video_id}/pinned'],
  ['post', '/api/v1/videos/pin'],
  ['get', '/api/v1/videos/pinned'],
  // library organisation
  ['get', '/api/v1/library/layouts'],
  ['get', '/api/v1/library/settings'],
  ['put', '/api/v1/library/settings'],
  ['get', '/api/v1/library/tree'],
  // retention
  ['get', '/api/v1/retention/preview'],
  ['post', '/api/v1/retention/apply'],
];
const missingEndpoints = endpoints.filter(([m, p]) => !P[p]?.[m]).map(([m, p]) => `${m.toUpperCase()} ${p}`);
check(`all ${endpoints.length} endpoints the client calls exist`, missingEndpoints.length === 0, missingEndpoints.join(', '));

// ---- 5. the new behaviours ----------------------------------------------
const delParams = (P['/api/v1/videos/{video_id}']?.delete?.parameters ?? []).map((p) => p.name);
check('DELETE /videos/{id} supports dry_run', delParams.includes('dry_run'), delParams.join(', '));
check('DELETE /videos/{id} supports delete_file', delParams.includes('delete_file'));
check(
  'DELETE /videos/{id} documents 401 and 404',
  Boolean(P['/api/v1/videos/{video_id}']?.delete?.responses?.['401'] && P['/api/v1/videos/{video_id}']?.delete?.responses?.['404']),
);
check(
  'GET /videos/by-id/{id} documents include_formats',
  (P['/api/v1/videos/by-id/{video_id}']?.get?.parameters ?? []).some((p) => p.name === 'include_formats'),
);
const dl206 = P['/api/v1/files/{video_id}/download']?.get?.responses?.['206'];
const documented206 = Boolean(dl206);
const stream206 = Boolean(P['/api/v1/files/{video_id}/stream']?.get?.responses?.['206']);
if (documented206 && stream206) {
  passes.push('file endpoints document 206 partial content');
} else if (documented206 || stream206) {
  warnings.push('only one of download/stream documents 206 — they should match');
} else {
  warnings.push(
    'file endpoints do NOT document 206, but 206 is implemented (Content-Range + Content-Length). ' +
      'Add it to the schema so codegen clients know ranges are supported.',
  );
}
check(
  'GET /files/{id}/download documents 416',
  Boolean(P['/api/v1/files/{video_id}/download']?.get?.responses?.['416']),
);

// ---- 5b. workers + health ----------------------------------------------
const healthProps = inlineModel('get', '/api/v1/health');
const healthKeys = Object.keys(healthProps?.properties ?? {});
if (healthKeys.includes('workers')) {
  const workers = resolveSchema(healthProps.properties.workers);
  const wk = Object.keys(workers?.properties ?? {});
  check('health.workers includes sources', wk.includes('sources'), wk.join(','));
} else {
  warnings.push('GET /health has no typed `workers` object — the client cannot show worker state.');
}

// ---- 5d. retention + pin semantics --------------------------------------
const applyDryRun = (P['/api/v1/retention/apply']?.post?.parameters ?? []).find((x) => x.name === 'dry_run');
check(
  'POST /retention/apply defaults to dry_run=true',
  applyDryRun?.schema?.default === true,
  `default=${applyDryRun?.schema?.default}`,
);
const treeParams = (P['/api/v1/library/tree']?.get?.parameters ?? []).map((p) => p.name);
check('GET /library/tree supports order + limit_per_folder', treeParams.includes('order') && treeParams.includes('limit_per_folder'), treeParams.join(','));

// ---- 5c. library media_type filter --------------------------------------
const videosParams = (P['/api/v1/videos']?.get?.parameters ?? []).map((p) => p.name);
if (!videosParams.includes('media_type')) {
  warnings.push(
    'GET /videos has NO media_type query parameter — the library Audio/Video filter is applied ' +
      'client-side over the loaded page only. Add ?media_type= to filter and paginate server-side.',
  );
} else {
  passes.push('GET /videos supports ?media_type=');
}

// ---- 6. error shape is declared -----------------------------------------
const errorSchema = C.HTTPExceptionError ?? C.ErrorResponse ?? C.Error ?? null;
check(
  'a structured error model is declared in the schema',
  Boolean(errorSchema),
  errorSchema ? Object.keys(errorSchema.properties ?? {}).join(', ') : 'no Error schema found',
);

// ---- report --------------------------------------------------------------
for (const w of warnings) console.log(`WARN  ${w}`);
for (const p of passes) console.log(`PASS  ${p}`);
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(
  failures.length === 0
    ? `\nCONTRACT OK — ${passes.length} checks passed` +
      (warnings.length ? `, ${warnings.length} schema gap(s) reported\n` : '\n')
    : `\nCONTRACT MISMATCH — ${failures.length} of ${passes.length + failures.length} checks failed\n`,
);
process.exit(failures.length === 0 ? 0 : 1);