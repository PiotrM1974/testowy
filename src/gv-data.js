const LEGACY_KEYS = new Set([
  'gymverse_schema', 'gymverse_history', 'gymverse_active', 'gymverse_plans',
  'gymverse_custom', 'gymverse_body', 'gymverse_last_weights', 'gymverse_rest',
  'gymverse_bar', 'gymverse_last_backup', 'gymverse_deload_until',
  'gymverse_deload_start', 'gymverse_deload_snooze', 'gymverse_goal',
  'gymverse_history_backup_v1', 'gymverse_draft_v1'
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  const text = typeof value === 'string' ? value : canonical(value);
  let hash = 14695981039346656037n;
  const mask = (1n << 64n) - 1n;
  for (const character of text) {
    hash ^= BigInt(character.codePointAt(0));
    hash = (hash * 1099511628211n) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

function legacySessionContent(session) {
  const { id, ...content } = session || {};
  if (Array.isArray(content.details)) content.details = content.details.map(set => {
    if (!isPlainObject(set)) return set;
    const { id: setId, ...setContent } = set;
    return setContent;
  });
  return content;
}

export function legacySessionFingerprint(session) {
  return stableHash(legacySessionContent(session));
}

export function ensureStableHistoryIds(history) {
  if (!Array.isArray(history)) return [];
  const multiplicity = new Map();
  return history.map(session => {
    if (!isPlainObject(session)) return session;
    const fingerprint = legacySessionFingerprint(session);
    const occurrence = (multiplicity.get(fingerprint) || 0) + 1;
    multiplicity.set(fingerprint, occurrence);
    const id = typeof session.id === 'string' && session.id ? session.id : `legacy-session-${fingerprint}-${occurrence}`;
    const details = Array.isArray(session.details) ? session.details.map((set, index) => {
      if (!isPlainObject(set)) return set;
      return { ...set, id: typeof set.id === 'string' && set.id ? set.id : `legacy-set-${stableHash(`${id}|${stableHash(set)}`)}-${index + 1}` };
    }) : session.details;
    return { ...session, id, ...(Array.isArray(details) ? { details } : {}) };
  });
}

export function addStableIdentifiers(snapshot) {
  const result = structuredClone(snapshot);
  if (Array.isArray(result.gymverse_history)) result.gymverse_history = ensureStableHistoryIds(result.gymverse_history);
  const active = result.gymverse_active;
  if (isPlainObject(active)) {
    if (typeof active.id !== 'string' || !active.id) active.id = `legacy-session-${stableHash(legacySessionContent(active))}-1`;
    if (Array.isArray(active.sets)) active.sets = active.sets.map((set, index) => isPlainObject(set) ? {
      ...set,
      id: typeof set.id === 'string' && set.id ? set.id : `legacy-set-${stableHash(`${active.id}|${stableHash(set)}`)}-${index + 1}`
    } : set);
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function add(anomalies, code) {
  if (!anomalies.includes(code)) anomalies.push(code);
}

export async function inspectLegacySnapshot(snapshot, validationOptions = {}) {
  const anomalies = [];
  const counts = { sessions: 0, sets: 0, plans: 0, customExercises: 0, drafts: 0, bodyMeasurements: 0, legacyInterpretations: 0 };
  if (!isPlainObject(snapshot)) {
    return { ok: false, sha256: null, counts, schemaKeys: [], anomalies: ['ROOT_NOT_OBJECT'] };
  }

  const v4Keys = new Set(['app', 'version', 'exportedAt', 'history', 'lastWeights', 'body', 'plans', 'custom', 'activeWorkout', 'drafts']);
  const isV4 = snapshot.app === 'gymverse' && Number(snapshot.version) === 4;
  let source = snapshot;
  let knownKeys = LEGACY_KEYS;
  if (isV4) {
    source = {
      gymverse_schema: 4,
      gymverse_history: snapshot.history,
      gymverse_last_weights: snapshot.lastWeights,
      gymverse_body: snapshot.body,
      gymverse_plans: snapshot.plans,
      gymverse_custom: snapshot.custom,
      ...(snapshot.activeWorkout == null ? {} : { gymverse_active: snapshot.activeWorkout }),
      ...(snapshot.drafts == null ? {} : { gymverse_draft_v1: snapshot.drafts })
    };
    knownKeys = v4Keys;
  }
  const schemaKeys = Object.keys(source).filter(key => LEGACY_KEYS.has(key)).sort();
  Object.keys(isV4 ? snapshot : source).forEach(key => { if (!knownKeys.has(key)) add(anomalies, 'UNKNOWN_KEY'); });
  snapshot = source;
  const exerciseCatalog = { ...(validationOptions.catalog || {}) };
  const bodyweightExercises = new Set(validationOptions.bodyweightExerciseIds || []);
  Object.entries(snapshot.gymverse_custom || {}).forEach(([id, exercise]) => {
    if (exercise && typeof exercise.name === 'string') exerciseCatalog[id] = exercise.name;
    if (exercise && exercise.bw === true) bodyweightExercises.add(id);
  });
  if (snapshot.gymverse_history != null && !Array.isArray(snapshot.gymverse_history)) add(anomalies, 'HISTORY_NOT_ARRAY');
  if (Array.isArray(snapshot.gymverse_history)) {
    counts.sessions = snapshot.gymverse_history.length;
    snapshot.gymverse_history.forEach(session => {
      if (!isPlainObject(session) || !Array.isArray(session.details)) { add(anomalies, 'INVALID_SESSION'); return; }
      session.details.forEach(set => {
        counts.sets += 1;
        if (!isPlainObject(set) || typeof set.exerciseId !== 'string' || !Number.isFinite(Number(set.weight)) || Number(set.weight) < 0 || !Number.isInteger(Number(set.reps)) || Number(set.reps) <= 0) add(anomalies, 'INVALID_SERIES');
        else if (validationOptions.strictExerciseCatalog) {
          const exerciseId = (validationOptions.exerciseIdMap || {})[set.exerciseId] || set.exerciseId;
          if (!Object.hasOwn(exerciseCatalog, exerciseId)) add(anomalies, 'EXERCISE_UNKNOWN');
          else if (Number(set.weight) === 0 && !bodyweightExercises.has(exerciseId)) add(anomalies, 'SERIES_WEIGHT_MODE_INVALID');
        }
      });
    });
  }
  if (snapshot.gymverse_plans != null && !Array.isArray(snapshot.gymverse_plans)) add(anomalies, 'PLANS_NOT_ARRAY');
  else {
    counts.plans = (snapshot.gymverse_plans || []).length;
    if ((snapshot.gymverse_plans || []).some(plan => !isPlainObject(plan) || typeof plan.id !== 'string' || !Array.isArray(plan.exercises) || plan.exercises.some(exercise => !isPlainObject(exercise) || typeof exercise.key !== 'string' || !Number.isInteger(Number(exercise.sets)) || Number(exercise.sets) < 1))) add(anomalies, 'PLANS_INVALID');
  }
  if (snapshot.gymverse_custom != null && !isPlainObject(snapshot.gymverse_custom)) add(anomalies, 'CUSTOM_NOT_OBJECT');
  else {
    counts.customExercises = Object.keys(snapshot.gymverse_custom || {}).length;
    if (Object.entries(snapshot.gymverse_custom || {}).some(([key, exercise]) => !/^c_[a-z0-9_]{1,40}$/.test(key) || !isPlainObject(exercise) || typeof exercise.name !== 'string' || exercise.name.trim().length < 2 || (exercise.bw != null && typeof exercise.bw !== 'boolean'))) add(anomalies, 'CUSTOM_INVALID');
  }
  if (snapshot.gymverse_body != null && !Array.isArray(snapshot.gymverse_body)) add(anomalies, 'BODY_NOT_ARRAY');
  else {
    counts.bodyMeasurements = (snapshot.gymverse_body || []).length;
    if ((snapshot.gymverse_body || []).some(item => !isPlainObject(item) || typeof item.date !== 'string' || !Number.isFinite(Number(item.kg)) || Number(item.kg) <= 0)) add(anomalies, 'BODY_INVALID');
  }
  if (snapshot.gymverse_last_weights != null && !isPlainObject(snapshot.gymverse_last_weights)) add(anomalies, 'LAST_WEIGHTS_NOT_OBJECT');
  else if (Object.values(snapshot.gymverse_last_weights || {}).some(rows => !Array.isArray(rows) || rows.some(row => !isPlainObject(row) || !Number.isFinite(Number(row.weight)) || Number(row.weight) < 0 || !Number.isInteger(Number(row.reps)) || Number(row.reps) <= 0))) add(anomalies, 'LAST_WEIGHTS_INVALID');
  if (snapshot.gymverse_schema != null && (!Number.isInteger(Number(snapshot.gymverse_schema)) || Number(snapshot.gymverse_schema) < 1 || Number(snapshot.gymverse_schema) > 4)) add(anomalies, 'SCHEMA_UNSUPPORTED');
  if (snapshot.gymverse_active != null && !isPlainObject(snapshot.gymverse_active)) add(anomalies, 'ACTIVE_NOT_OBJECT');
  if (snapshot.gymverse_draft_v1 != null) {
    const drafts = snapshot.gymverse_draft_v1;
    if (!isPlainObject(drafts) || drafts.version !== 1 || !Array.isArray(drafts.items) || drafts.items.some(item => !isPlainObject(item) || typeof item.planId !== 'string' || typeof item.sessionId !== 'string' || !Number.isInteger(Number(item.step)) || Number(item.step) < 0 || !Number.isInteger(Number(item.setNumber)) || Number(item.setNumber) < 1 || typeof item.weight !== 'string' || typeof item.reps !== 'string')) add(anomalies, 'DRAFT_INVALID');
    else counts.drafts = drafts.items.length;
  }

  const bytes = new TextEncoder().encode(canonical(snapshot));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { ok: anomalies.length === 0, sha256, counts, schemaKeys, anomalies };
}

const DB_NAME = 'gymverse-db-v3';
const DB_VERSION = 4;
const RECORDS = 'snapshotRecords';
const RUNTIME_RECORDS = 'runtimeRecords';
const META = 'meta';
const INTERPRETATIONS = 'legacyInterpretations';
const CUSTOM_MEDIA = 'customMedia';

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(RUNTIME_RECORDS)) db.createObjectStore(RUNTIME_RECORDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(INTERPRETATIONS)) db.createObjectStore(INTERPRETATIONS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CUSTOM_MEDIA)) db.createObjectStore(CUSTOM_MEDIA, { keyPath: 'id' });
    };
    request.onerror = () => { settled = true; reject(request.error || new Error('DATABASE_OPEN_FAILED')); };
    request.onblocked = () => { settled = true; reject(new Error('DATABASE_OPEN_BLOCKED')); };
    request.onsuccess = () => {
      if (settled) request.result.close();
      else { settled = true; resolve(request.result); }
    };
  });
}

const RUNTIME_POINTER = 'runtimeActive';
const RUNTIME_LATCH = 'gymverse_storage_mode';
const RUNTIME_REVISION = 'runtimeRevision';

function parseRuntimeValue(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (_) { return { __gymverseRaw: raw }; }
}

function readStorageSnapshot(storage) {
  const snapshot = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (typeof key === 'string' && key.startsWith('gymverse_') && key !== RUNTIME_LATCH) snapshot[key] = storage.getItem(key);
  }
  return snapshot;
}

async function runtimeDigest(snapshot) {
  const bytes = new TextEncoder().encode(canonical(snapshot));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function inspectRuntimeSnapshot(rawSnapshot) {
  const values = {};
  for (const [key, raw] of Object.entries(rawSnapshot)) {
    try { values[key] = JSON.parse(raw); }
    catch (_) { throw new Error('SOURCE_VALUE_INVALID'); }
  }
  const inspection = await inspectLegacySnapshot(values);
  if (!inspection.ok) {
    const error = new Error('LEGACY_SNAPSHOT_INVALID');
    error.anomalies = inspection.anomalies;
    throw error;
  }
  return inspection;
}

function cloneRuntimeValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Runtime key/value adapter. It starts in localStorage and changes to IndexedDB
 * only after an explicit, locked, source-hash-checked and read-back-verified cutover.
 */
export async function createRuntimeStore(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const getIndexedDB = options.getIndexedDB || (() => globalThis.indexedDB);
  const locks = options.locks === undefined ? globalThis.navigator && globalThis.navigator.locks : options.locks;
  const channel = options.broadcast === false || typeof globalThis.BroadcastChannel !== 'function'
    ? null : new BroadcastChannel(options.broadcastChannelName || 'gymverse-runtime-store');
  const tabId = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const livePeers = new Set();
  const cache = new Map();
  let mode = 'localStorage';
  let blocked = false;
  let writePaused = false;
  let revision = 0;
  let persistQueue = Promise.resolve();
  let onFailure = () => {};

  const activeDatabase = () => {
    if (blocked) throw new Error('ACTIVE_DATABASE_UNAVAILABLE');
    const factory = getIndexedDB();
    if (!factory) throw new Error('ACTIVE_DATABASE_UNAVAILABLE');
    return openDatabase(factory);
  };
  const withMigrationLock = async callback => {
    if (!locks || typeof locks.request !== 'function') throw new Error('MIGRATION_LOCK_UNAVAILABLE');
    let result;
    await locks.request('gymverse-data-migration', { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('MIGRATION_LOCK_BUSY');
      if (!channel) throw new Error('MIGRATION_TAB_COORDINATION_UNAVAILABLE');
      livePeers.clear();
      channel.postMessage({ type: 'tab-probe', source: tabId });
      await new Promise(resolve => setTimeout(resolve, 250));
      if (livePeers.size) throw new Error('OTHER_TABS_OPEN');
      writePaused = true;
      channel.postMessage({ type: 'migration-started', source: tabId });
      try { result = await callback(); }
      finally {
        channel.postMessage({ type: 'migration-finished', source: tabId });
        writePaused = false;
      }
    });
    return result;
  };
  const readActiveSnapshot = async db => {
    const tx = db.transaction([RUNTIME_RECORDS, META], 'readonly');
    const [pointer, storedRevision, records] = await Promise.all([
      requestValue(tx.objectStore(META).get(RUNTIME_POINTER)),
      requestValue(tx.objectStore(META).get(RUNTIME_REVISION)),
      requestValue(tx.objectStore(RUNTIME_RECORDS).getAll())
    ]);
    await transactionDone(tx);
    if (!pointer) return null;
    const selected = records.filter(record => record.generation === pointer.generation);
    const snapshot = Object.fromEntries(selected.map(record => [record.id.slice(record.id.indexOf(':') + 1), record.raw]));
    if (selected.length !== pointer.count || await runtimeDigest(snapshot) !== pointer.sha256) throw new Error('ACTIVE_DATABASE_INTEGRITY_FAILED');
    cache.clear();
    Object.entries(snapshot).forEach(([key, raw]) => cache.set(key, parseRuntimeValue(raw)));
    revision = storedRevision && Number(storedRevision.value) || 0;
    return pointer;
  };

  const persistIndexedSnapshot = async (snapshotOverride = null) => {
    const database = await activeDatabase();
    try {
      const snapshot = snapshotOverride || await adapter.exportSnapshot();
      const digest = await runtimeDigest(snapshot);
      const nextRevision = revision + 1;
      const tx = database.transaction([RUNTIME_RECORDS, META], 'readwrite');
      const records = tx.objectStore(RUNTIME_RECORDS);
      const meta = tx.objectStore(META);
      let conflict = false;
      let pointer = null;
      meta.get(RUNTIME_REVISION).onsuccess = event => {
        const currentRevision = event.target.result && Number(event.target.result.value) || 0;
        if (currentRevision !== revision) { conflict = true; tx.abort(); return; }
        meta.get(RUNTIME_POINTER).onsuccess = pointerEvent => {
          pointer = pointerEvent.target.result;
          if (!pointer) { tx.abort(); return; }
          records.getAll().onsuccess = recordsEvent => {
            recordsEvent.target.result.filter(record => record.generation === pointer.generation).forEach(record => records.delete(record.id));
            for (const [key, raw] of Object.entries(snapshot)) records.put({ id: `${pointer.generation}:${key}`, generation: pointer.generation, raw });
            meta.put({ key: RUNTIME_REVISION, value: nextRevision });
            meta.put({ ...pointer, sha256: digest, count: Object.keys(snapshot).length });
          };
        };
      };
      try { await transactionDone(tx); }
      catch (error) {
        if (conflict) { await readActiveSnapshot(database); throw new Error('CROSS_TAB_CONFLICT'); }
        throw error;
      }
      revision = nextRevision;
      if (channel) channel.postMessage({ type: 'runtime-updated' });
      return { status: 'saved', mode, revision };
    } finally { database.close(); }
  };

  const queueIndexedWrite = () => {
    persistQueue = persistQueue.catch(() => {}).then(() => {
      if (blocked) throw new Error('ACTIVE_DATABASE_UNAVAILABLE');
      return persistIndexedSnapshot();
    }).catch(error => {
      blocked = true;
      onFailure(error);
      throw error;
    });
    return persistQueue;
  };

  const adapter = {
    get mode() { return mode; },
    get(key, fallback = null) { return cache.has(key) ? cloneRuntimeValue(cache.get(key)) : fallback; },
    async exportSnapshot() {
      if (mode === 'localStorage') {
        const liveSnapshot = readStorageSnapshot(storage);
        cache.clear();
        Object.entries(liveSnapshot).forEach(([key, raw]) => cache.set(key, parseRuntimeValue(raw)));
        return liveSnapshot;
      }
      const result = {};
      for (const [key, value] of cache) result[key] = value && value.__gymverseRaw !== undefined ? value.__gymverseRaw : JSON.stringify(value);
      return result;
    },
    setFailureHandler(handler) { onFailure = typeof handler === 'function' ? handler : () => {}; },
    async flush() { return persistQueue; },
    storage: {
      getItem(key) {
        if (!cache.has(key)) return null;
        const value = cache.get(key);
        return value && value.__gymverseRaw !== undefined ? value.__gymverseRaw : JSON.stringify(value);
      },
      setItem(key, raw) {
        if (writePaused && key !== RUNTIME_LATCH) throw new Error('MIGRATION_IN_PROGRESS');
        if (blocked && mode === 'indexeddb') throw new Error('ACTIVE_DATABASE_UNAVAILABLE');
        const value = parseRuntimeValue(String(raw));
        cache.set(key, value);
        if (mode === 'indexeddb') queueIndexedWrite().catch(() => {});
        else storage.setItem(key, String(raw));
      },
      removeItem(key) {
        if (writePaused && key !== RUNTIME_LATCH) throw new Error('MIGRATION_IN_PROGRESS');
        if (blocked && mode === 'indexeddb') throw new Error('ACTIVE_DATABASE_UNAVAILABLE');
        cache.delete(key);
        if (mode === 'indexeddb') queueIndexedWrite().catch(() => {});
        else storage.removeItem(key);
      }
    },
    async restoreSnapshot(updates, auxiliary = {}) {
      if (mode !== 'indexeddb') return adapter.transact(updates);
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('STORE_UPDATES_INVALID');
      if (writePaused) throw new Error('MIGRATION_IN_PROGRESS');
      const nextSnapshot = await adapter.exportSnapshot();
      for (const [key, value] of Object.entries(updates)) value === null ? delete nextSnapshot[key] : nextSnapshot[key] = JSON.stringify(value);
      const digest = await runtimeDigest(nextSnapshot);
      const batchId = auxiliary.batchId || digest;
      const interpretations = (auxiliary.interpretations || []).map(normalizeInterpretation);
      const media = auxiliary.media || [];
      if (new Set(interpretations.map(item => item.id)).size !== interpretations.length || new Set(media.map(item => item.name)).size !== media.length) throw new Error('RESTORE_AUXILIARY_DUPLICATE');
      const database = await activeDatabase();
      let committed = false;
      try {
        const nextRevision = revision + 1;
        const tx = database.transaction([RUNTIME_RECORDS, META, INTERPRETATIONS, CUSTOM_MEDIA], 'readwrite');
        const records = tx.objectStore(RUNTIME_RECORDS);
        const meta = tx.objectStore(META);
        let conflict = false;
        meta.get(RUNTIME_REVISION).onsuccess = event => {
          const currentRevision = event.target.result && Number(event.target.result.value) || 0;
          if (currentRevision !== revision) { conflict = true; tx.abort(); return; }
          meta.get(RUNTIME_POINTER).onsuccess = pointerEvent => {
            const pointer = pointerEvent.target.result;
            if (!pointer) { tx.abort(); return; }
            records.getAll().onsuccess = recordsEvent => {
              recordsEvent.target.result.filter(record => record.generation === pointer.generation).forEach(record => records.delete(record.id));
              for (const [key, raw] of Object.entries(nextSnapshot)) records.put({ id: `${pointer.generation}:${key}`, generation: pointer.generation, raw });
              interpretations.forEach(item => tx.objectStore(INTERPRETATIONS).put({ ...item, id: `${batchId}:${item.id}`, originalId: item.id, batchId }));
              media.forEach(item => tx.objectStore(CUSTOM_MEDIA).put({ id: `${batchId}:${item.name}`, originalName: item.name, name: item.name, bytes: item.bytes, batchId }));
              meta.put({ key: RUNTIME_REVISION, value: nextRevision });
              meta.put({ ...pointer, sha256: digest, count: Object.keys(nextSnapshot).length });
              meta.put({ key: 'activeInterpretationBatch', batchId });
              meta.put({ key: 'activeCustomMediaBatch', batchId });
            };
          };
        };
        try { await transactionDone(tx); }
        catch (error) {
          if (conflict) { await readActiveSnapshot(database); throw new Error('CROSS_TAB_CONFLICT'); }
          throw error;
        }
        committed = true;
        cache.clear();
        Object.entries(nextSnapshot).forEach(([key, raw]) => cache.set(key, parseRuntimeValue(raw)));
        revision = nextRevision;
        if (channel) channel.postMessage({ type: 'runtime-updated' });
        await readActiveSnapshot(database);
        const verifyTx = database.transaction([INTERPRETATIONS, CUSTOM_MEDIA], 'readonly');
        const [allInterpretations, allMedia] = await Promise.all([
          requestValue(verifyTx.objectStore(INTERPRETATIONS).getAll()),
          requestValue(verifyTx.objectStore(CUSTOM_MEDIA).getAll())
        ]);
        await transactionDone(verifyTx);
        const verifiedInterpretations = allInterpretations.filter(item => item.batchId === batchId);
        const verifiedMedia = allMedia.filter(item => item.batchId === batchId);
        if (verifiedInterpretations.length !== interpretations.length || verifiedInterpretations.some(item => {
          const expected = interpretations.find(row => row.id === item.originalId);
          if (!expected) return true;
          const { id: storedId, originalId, batchId: storedBatchId, ...rest } = item;
          const actual = { id: originalId, ...rest };
          return canonical(actual) !== canonical(expected);
        }) || verifiedMedia.length !== media.length || verifiedMedia.some(item => {
          const expected = media.find(row => row.name === item.name);
          return !expected || item.bytes.byteLength !== expected.bytes.byteLength || item.bytes.some((byte, index) => byte !== expected.bytes[index]);
        })) throw new Error('RESTORE_AUXILIARY_READBACK_MISMATCH');
        return { status: 'restored', keys: Object.keys(nextSnapshot).length, revision };
      } catch (error) {
        if (error.message === 'CROSS_TAB_CONFLICT') throw error;
        blocked = true;
        const failure = new Error('ACTIVE_DATABASE_UNAVAILABLE', { cause: error });
        if (committed) failure.integrityUncertain = true;
        throw failure;
      } finally { database.close(); }
    },
    async previewMigration() {
      if (mode !== 'localStorage') throw new Error('MIGRATION_ALREADY_ACTIVE');
      const rawSnapshot = readStorageSnapshot(storage);
      await inspectRuntimeSnapshot(rawSnapshot);
      cache.clear();
      Object.entries(rawSnapshot).forEach(([key, raw]) => cache.set(key, parseRuntimeValue(raw)));
      return { source: rawSnapshot, sha256: await runtimeDigest(rawSnapshot), count: Object.keys(rawSnapshot).length };
    },
    async activateMigration(preview, confirmations = {}) {
      if (confirmations.sourceExportVerified !== true) throw new Error('SOURCE_EXPORT_NOT_VERIFIED');
      if (confirmations.v5ExportVerified !== true) throw new Error('V5_EXPORT_NOT_VERIFIED');
      return withMigrationLock(async () => {
        if (mode === 'indexeddb') return { status: 'already-active', sha256: preview.sha256 };
        if (!preview || !preview.source || typeof preview.sha256 !== 'string') throw new Error('MIGRATION_PREVIEW_INVALID');
        const currentSource = readStorageSnapshot(storage);
        if (await runtimeDigest(currentSource) !== preview.sha256) throw new Error('SOURCE_CHANGED_DURING_MIGRATION');
        await inspectRuntimeSnapshot(currentSource);
        const generation = preview.sha256;
        const factory = getIndexedDB();
        if (!factory) throw new Error('INDEXEDDB_UNSUPPORTED');
        const database = await openDatabase(factory);
        try {
          const stateTx = database.transaction(META, 'readonly');
          const existing = await requestValue(stateTx.objectStore(META).get(RUNTIME_POINTER));
          await transactionDone(stateTx);
          if (existing) {
            if (existing.sha256 !== preview.sha256) throw new Error('ACTIVE_DATABASE_EXISTS');
            await readActiveSnapshot(database);
            mode = 'indexeddb';
            return { status: 'already-active', sha256: existing.sha256 };
          }
        storage.setItem(RUNTIME_LATCH, 'indexeddb-pending');
        const entries = Object.entries(preview.source);
          const stageTx = database.transaction([RUNTIME_RECORDS, META], 'readwrite');
          const store = stageTx.objectStore(RUNTIME_RECORDS);
          store.getAll().onsuccess = event => {
            for (const old of event.target.result) store.delete(old.id);
            for (const [key, raw] of entries) store.put({ id: `${generation}:${key}`, generation, raw });
            stageTx.objectStore(META).put({ key: 'runtimePrepared', generation, sha256: preview.sha256, count: entries.length });
            stageTx.objectStore(META).put({ key: RUNTIME_REVISION, value: 0 });
          };
          await transactionDone(stageTx);
          const checkTx = database.transaction(RUNTIME_RECORDS, 'readonly');
          const checks = await Promise.all(entries.map(([key]) => requestValue(checkTx.objectStore(RUNTIME_RECORDS).get(`${generation}:${key}`))));
          await transactionDone(checkTx);
          const verified = Object.fromEntries(checks.filter(Boolean).map(item => [item.id.slice(item.id.indexOf(':') + 1), item.raw]));
          if (checks.length !== entries.length || checks.some((item, index) => !item || item.raw !== entries[index][1]) || await runtimeDigest(verified) !== preview.sha256) throw new Error('MIGRATION_READBACK_MISMATCH');
          const sourceAfterPreparation = readStorageSnapshot(storage);
          if (await runtimeDigest(sourceAfterPreparation) !== preview.sha256) throw new Error('SOURCE_CHANGED_DURING_MIGRATION');
          const commitTx = database.transaction(META, 'readwrite');
          commitTx.objectStore(META).put({ key: RUNTIME_POINTER, generation, sha256: preview.sha256, count: entries.length, schemaVersion: DB_VERSION, activatedAt: new Date().toISOString() });
          commitTx.objectStore(META).delete('runtimePrepared');
          await transactionDone(commitTx);
          try { storage.setItem(RUNTIME_LATCH, 'indexeddb'); } catch (_) { /* The committed DB pointer is authoritative. */ }
          entries.forEach(([key, raw]) => cache.set(key, parseRuntimeValue(raw)));
          mode = 'indexeddb';
          revision = 0;
          if (channel) channel.postMessage({ type: 'runtime-updated' });
          return { status: 'activated', sha256: preview.sha256, records: entries.length };
        } finally { database.close(); }
      });
    },
    async transact(updates) {
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('STORE_UPDATES_INVALID');
      if (writePaused) throw new Error('MIGRATION_IN_PROGRESS');
      if (mode === 'localStorage') {
        const before = new Map();
        try {
          for (const [key, value] of Object.entries(updates)) {
            before.set(key, storage.getItem(key));
            if (value === null) storage.removeItem(key); else storage.setItem(key, JSON.stringify(value));
            if (storage.getItem(key) !== (value === null ? null : JSON.stringify(value))) throw new Error('STORE_READBACK_FAILED');
          }
        } catch (error) {
          for (const [key, raw] of Array.from(before.entries()).reverse()) {
            try { if (raw === null) storage.removeItem(key); else storage.setItem(key, raw); } catch (_) {}
          }
          throw error;
        }
        for (const [key, value] of Object.entries(updates)) value === null ? cache.delete(key) : cache.set(key, cloneRuntimeValue(value));
        return { status: 'saved', mode };
      }
      const operation = persistQueue.catch(() => {}).then(async () => {
        if (blocked) throw new Error('ACTIVE_DATABASE_UNAVAILABLE');
        if (writePaused) throw new Error('MIGRATION_IN_PROGRESS');
        const snapshot = await adapter.exportSnapshot();
        for (const [key, value] of Object.entries(updates)) value === null ? delete snapshot[key] : snapshot[key] = JSON.stringify(value);
        const result = await persistIndexedSnapshot(snapshot);
        cache.clear();
        Object.entries(snapshot).forEach(([key, raw]) => cache.set(key, parseRuntimeValue(raw)));
        return result;
      }).catch(error => {
        blocked = true;
        onFailure(error);
        if (error.message === 'CROSS_TAB_CONFLICT') throw error;
        throw new Error('ACTIVE_DATABASE_UNAVAILABLE', { cause: error });
      });
      persistQueue = operation;
      return operation;
    },
    async set(key, value) { return adapter.transact({ [key]: value }); },
    async delete(key) { return adapter.transact({ [key]: null }); },
    close() { if (channel) channel.close(); }
  };
  adapter.storage.__gymverseRuntimeStore = adapter;

  const latch = storage.getItem(RUNTIME_LATCH);
  let db;
  try { db = await activeDatabase(); }
  catch (error) {
    if (latch === 'indexeddb' || latch === 'indexeddb-pending') throw new Error('ACTIVE_DATABASE_UNAVAILABLE', { cause: error });
    const snapshot = readStorageSnapshot(storage);
    Object.entries(snapshot).forEach(([key, raw]) => cache.set(key, parseRuntimeValue(raw)));
    return adapter;
  }
  try {
    const pointer = await readActiveSnapshot(db);
    if (pointer) {
      mode = 'indexeddb';
      if (latch !== 'indexeddb') {
        try { storage.setItem(RUNTIME_LATCH, 'indexeddb'); }
        catch (_) { /* The committed IndexedDB pointer remains authoritative. */ }
      }
    } else if (latch === 'indexeddb') {
      throw new Error('ACTIVE_DATABASE_UNAVAILABLE');
    } else {
      const snapshot = readStorageSnapshot(storage);
      Object.entries(snapshot).forEach(([key, raw]) => cache.set(key, parseRuntimeValue(raw)));
    }
  } finally { db.close(); }

  const refreshFromDatabase = async () => {
    const current = await activeDatabase();
    try { await readActiveSnapshot(current); } finally { current.close(); }
  };
  if (channel) channel.onmessage = event => {
    const message = event.data || {};
    if (message.source === tabId) return;
    if (message.type === 'tab-probe') channel.postMessage({ type: 'tab-present', source: tabId, target: message.source });
    else if (message.type === 'tab-present' && message.target === tabId) livePeers.add(message.source);
    else if (message.type === 'migration-started') { writePaused = true; channel.postMessage({ type: 'migration-paused', source: tabId, target: message.source }); }
    else if (message.type === 'migration-finished') { blocked = true; onFailure(new Error('MIGRATION_COMPLETED_RELOAD')); }
    else if (message.type === 'runtime-updated' && mode === 'indexeddb') refreshFromDatabase().catch(() => { blocked = true; });
  };
  return adapter;
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('DATABASE_TRANSACTION_FAILED'));
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('DATABASE_REQUEST_FAILED'));
  });
}

/**
 * Stage and verify an explicit legacy snapshot before atomically switching the DB pointer.
 * The supplied object is never mutated and no browser storage outside this database is touched.
 */
export async function stageLegacyMigration(snapshot, options = {}) {
  const factory = options.indexedDB || globalThis.indexedDB;
  if (!factory) throw new Error('INDEXEDDB_UNSUPPORTED');
  const stagedSnapshot = snapshot && snapshot.app === 'gymverse' && Number(snapshot.version) === 4
    ? normalizeV4Export(snapshot)
    : snapshot;
  const inspection = await inspectLegacySnapshot(stagedSnapshot);
  if (!inspection.ok) {
    const error = new Error('LEGACY_SNAPSHOT_INVALID');
    error.anomalies = inspection.anomalies;
    throw error;
  }

  const db = await openDatabase(factory);
  const prefix = `${inspection.sha256}:`;
  try {
    const activeTx = db.transaction(META, 'readonly');
    const active = await requestValue(activeTx.objectStore(META).get('activeSnapshot'));
    await transactionDone(activeTx);
    if (active && active.sha256 === inspection.sha256) return { status: 'already-active', sha256: inspection.sha256, counts: inspection.counts };
    if (active) throw new Error('ACTIVE_SNAPSHOT_EXISTS');

    const entries = Object.entries(stagedSnapshot);
    const writeTx = db.transaction(RECORDS, 'readwrite');
    const records = writeTx.objectStore(RECORDS);
    for (const [key, value] of entries) records.put({ id: prefix + key, key, value });
    await transactionDone(writeTx);

    const verifyTx = db.transaction(RECORDS, 'readonly');
    const verifyStore = verifyTx.objectStore(RECORDS);
    const verified = await Promise.all(entries.map(([key]) => requestValue(verifyStore.get(prefix + key))));
    await transactionDone(verifyTx);
    if (verified.length !== entries.length || verified.some((record, index) => !record || record.key !== entries[index][0] || canonical(record.value) !== canonical(entries[index][1]))) {
      throw new Error('DATABASE_READBACK_MISMATCH');
    }

    const pointerTx = db.transaction(META, 'readwrite');
    const pointerStore = pointerTx.objectStore(META);
    const pointer = await requestValue(pointerStore.get('activeSnapshot'));
    if (pointer) {
      pointerTx.abort();
      await transactionDone(pointerTx).catch(() => {});
      throw new Error(pointer.sha256 === inspection.sha256 ? 'MIGRATION_ALREADY_ACTIVATED' : 'ACTIVE_SNAPSHOT_EXISTS');
    }
    pointerStore.put({ key: 'activeSnapshot', sha256: inspection.sha256, prefix, keys: entries.map(([key]) => key), counts: inspection.counts });
    await transactionDone(pointerTx);
    return { status: 'activated', sha256: inspection.sha256, counts: inspection.counts };
  } finally {
    db.close();
  }
}

export const GV_DATA_LEGACY_KEYS = Object.freeze(Array.from(LEGACY_KEYS));
import './vendor/zip.min.js';

const zipApi = globalThis.zip || await import('@zip.js/zip.js');
const { BlobReader, BlobWriter, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } = zipApi;


const SETTINGS_KEYS = new Set([
  'gymverse_rest', 'gymverse_bar', 'gymverse_deload_until', 'gymverse_deload_start',
  'gymverse_deload_snooze', 'gymverse_goal', 'gymverse_last_backup'
]);
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 256;
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;
const V5_FILES = new Set(['manifest.json', 'data.json', 'settings.json', 'checksums.json']);
const IMAGE_SIGNATURES = {
  png: [137, 80, 78, 71, 13, 10, 26, 10],
  jpg: [255, 216, 255],
  webp: [82, 73, 70, 70, null, null, null, null, 87, 69, 66, 80]
};

function utf8(value) { return new TextEncoder().encode(value); }

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeV4Export(parsed) {
  if (!isPlainObject(parsed) || parsed.app !== 'gymverse' || Number(parsed.version) !== 4) throw new Error('LEGACY_V4_INVALID');
  const allowed = new Set(['app', 'version', 'exportedAt', 'history', 'lastWeights', 'body', 'plans', 'custom', 'activeWorkout', 'drafts']);
  if (Object.keys(parsed).some(key => !allowed.has(key))) throw new Error('LEGACY_V4_UNKNOWN_FIELD');
  const snapshot = {
    gymverse_schema: 4,
    gymverse_history: parsed.history,
    gymverse_last_weights: parsed.lastWeights ?? {},
    gymverse_body: parsed.body ?? [],
    gymverse_plans: parsed.plans ?? [],
    gymverse_custom: parsed.custom ?? {}
  };
  if (parsed.activeWorkout != null) snapshot.gymverse_active = parsed.activeWorkout;
  if (parsed.drafts != null) snapshot.gymverse_draft_v1 = parsed.drafts;
  return snapshot;
}

function sanitizeRestoredActive(active) {
  if (!isPlainObject(active)) return active;
  const stripPush = value => {
    if (Array.isArray(value)) return value.map(stripPush);
    if (!isPlainObject(value)) return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(?:pushsubscription|vapid|push.?token|outbox|eventid|eventversion|cancelcommand)/i.test(key)) continue;
      out[key] = stripPush(item);
    }
    return out;
  };
  const safe = stripPush(active);
  if (safe.timer && isPlainObject(safe.timer)) {
    safe.timer.status = 'idle';
    safe.timer.endsAt = null;
    safe.timer.pushStatus = 'not_configured';
    delete safe.timer.interval;
  }
  if (Object.hasOwn(safe, 'timerEndAt')) safe.timerEndAt = 0;
  return safe;
}

/** Full legacy-v4 restore. It is deliberately separate from the v4 merge flow. */
export async function restoreLegacyV4(storage, parsed, options = {}) {
  if (options.confirmed !== true) throw new Error('RESTORE_CONFIRMATION_REQUIRED');
  if (typeof options.restoreActive !== 'boolean' || typeof options.restoreDrafts !== 'boolean') throw new Error('RESTORE_SESSION_CHOICES_REQUIRED');
  let snapshot = normalizeV4Export(parsed);
  const inspection = await inspectLegacySnapshot(snapshot, options.validationOptions || {});
  if (!inspection.ok) {
    const error = new Error('LEGACY_V4_INVALID');
    error.anomalies = inspection.anomalies;
    throw error;
  }
  snapshot = addStableIdentifiers(snapshot);
  if (!options.restoreActive) delete snapshot.gymverse_active;
  else if (snapshot.gymverse_active) snapshot.gymverse_active = sanitizeRestoredActive(snapshot.gymverse_active);
  if (!options.restoreDrafts) delete snapshot.gymverse_draft_v1;
  const keys = ['gymverse_schema', 'gymverse_history', 'gymverse_last_weights', 'gymverse_body', 'gymverse_plans', 'gymverse_custom', 'gymverse_active', 'gymverse_draft_v1'];
  const runtime = storage && storage.__gymverseRuntimeStore;
  if (runtime && runtime.mode === 'indexeddb') {
    const updates = Object.fromEntries(keys.map(key => [key, Object.hasOwn(snapshot, key) ? snapshot[key] : null]));
    const result = await runtime.restoreSnapshot(updates, { interpretations: [], media: [] });
    return { status: 'restored', counts: inspection.counts, revision: result.revision };
  }
  const before = new Map(keys.map(key => [key, storage.getItem(key)]));
  const attempted = [];
  try {
    for (const key of keys) {
      const value = Object.hasOwn(snapshot, key) ? JSON.stringify(snapshot[key]) : null;
      attempted.push(key);
      if (value === null) storage.removeItem(key); else storage.setItem(key, value);
      if (storage.getItem(key) !== value) throw new Error('RESTORE_READBACK_FAILED');
    }
    const indexedDBFactory = options.indexedDB || globalThis.indexedDB;
    if (indexedDBFactory) await replaceAuxiliaryBatch([], [], inspection.sha256, indexedDBFactory);
    return { status: 'restored', counts: inspection.counts };
  } catch (error) {
    error.rollbackErrors = [];
    for (const key of attempted.reverse()) {
      try {
        const previous = before.get(key);
        if (previous === null) storage.removeItem(key); else storage.setItem(key, previous);
        if (storage.getItem(key) !== previous) throw new Error('RESTORE_ROLLBACK_MISMATCH');
      } catch (rollbackError) { error.rollbackErrors.push(rollbackError); }
    }
    if (error.rollbackErrors.length) error.integrityUncertain = true;
    throw error;
  }
}

function splitSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || Object.keys(snapshot).some(key => !LEGACY_KEYS.has(key))) throw new Error('SNAPSHOT_KEYS_INVALID');
  const data = {};
  const settings = {};
  Object.entries(snapshot).forEach(([key, value]) => {
    (SETTINGS_KEYS.has(key) ? settings : data)[key] = value;
  });
  return { data, settings };
}

function bytesEqualPrefix(bytes, signature) {
  return signature.every((byte, index) => byte === null || bytes[index] === byte);
}

function normalizeInterpretation(item) {
  if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id || typeof item.exerciseId !== 'string' || !item.exerciseId ||
      !Array.isArray(item.sessionIds) || !item.sessionIds.length || item.sessionIds.some(id => typeof id !== 'string' || !id) ||
      !Number.isInteger(Number(item.ruleVersion)) || Number(item.ruleVersion) < 1 || item.source !== 'user_confirmed' ||
      typeof item.confirmedAt !== 'string' || !Number.isFinite(Date.parse(item.confirmedAt)) || !isPlainObject(item.interpretation)) {
    throw new Error('LEGACY_INTERPRETATION_INVALID');
  }
  return {
    id: item.id,
    exerciseId: item.exerciseId,
    sessionIds: [...new Set(item.sessionIds)],
    ruleVersion: Number(item.ruleVersion),
    source: 'user_confirmed',
    confirmedAt: item.confirmedAt,
    interpretation: structuredClone(item.interpretation)
  };
}

/** Save a user-confirmed legacy rule separately from immutable history records. */
export async function saveLegacyInterpretation(record, options = {}) {
  const factory = options.indexedDB || globalThis.indexedDB;
  if (!factory) throw new Error('INDEXEDDB_UNSUPPORTED');
  const input = { ...record, id: record && record.id || globalThis.crypto.randomUUID() };
  const normalized = normalizeInterpretation(input);
  const db = await openDatabase(factory);
  try {
    const transaction = db.transaction([INTERPRETATIONS, META], 'readwrite');
    const store = transaction.objectStore(INTERPRETATIONS);
    const meta = transaction.objectStore(META);
    const active = await requestValue(meta.get('activeInterpretationBatch'));
    const batchId = active && active.batchId || 'local';
    store.put({ ...normalized, batchId });
    if (!active) meta.put({ key: 'activeInterpretationBatch', batchId });
    await transactionDone(transaction);
    return normalized;
  } finally { db.close(); }
}

/** Read only the active interpretation set; staged/abandoned sets remain inactive. */
export async function readLegacyInterpretations(options = {}) {
  const factory = options.indexedDB || globalThis.indexedDB;
  if (!factory) return [];
  if (typeof factory.databases === 'function') {
    const databases = await factory.databases();
    if (!databases.some(item => item.name === DB_NAME)) return [];
  }
  const db = await openDatabase(factory);
  try {
    const tx = db.transaction([INTERPRETATIONS, META], 'readonly');
    const [pointer, records] = await Promise.all([
      requestValue(tx.objectStore(META).get('activeInterpretationBatch')),
      requestValue(tx.objectStore(INTERPRETATIONS).getAll())
    ]);
    await transactionDone(tx);
    if (!pointer) return [];
    return records.filter(item => item.batchId === pointer.batchId).map(({ batchId, originalId, ...item }) => ({ ...item, id: originalId || item.id }));
  } finally { db.close(); }
}

/** Read only image blobs attached to the active, verified backup generation. */
export async function readCustomMedia(options = {}) {
  const factory = options.indexedDB || globalThis.indexedDB;
  if (!factory) return [];
  if (typeof factory.databases === 'function') {
    const databases = await factory.databases();
    if (!databases.some(item => item.name === DB_NAME)) return [];
  }
  const db = await openDatabase(factory);
  try {
    const tx = db.transaction([CUSTOM_MEDIA, META], 'readonly');
    const [pointer, records] = await Promise.all([
      requestValue(tx.objectStore(META).get('activeCustomMediaBatch')),
      requestValue(tx.objectStore(CUSTOM_MEDIA).getAll())
    ]);
    await transactionDone(tx);
    if (!pointer) return [];
    return records.filter(item => item.batchId === pointer.batchId).map(({ id, batchId, ...item }) => item);
  } finally { db.close(); }
}

/** Report the browser's actual origin-storage persistence result without claiming a guarantee. */
export async function requestStoragePersistence(storageManager = globalThis.navigator && globalThis.navigator.storage) {
  if (!storageManager || typeof storageManager.persisted !== 'function' || typeof storageManager.persist !== 'function') return 'unsupported';
  try {
    if (await storageManager.persisted()) return 'persistent';
    return await storageManager.persist() ? 'persistent' : 'best-effort';
  } catch (_) { return 'best-effort'; }
}

async function replaceAuxiliaryBatch(records, media, batchId, factory = globalThis.indexedDB) {
  if (!factory) throw new Error('INDEXEDDB_UNSUPPORTED');
  const normalized = records.map(normalizeInterpretation);
  const db = await openDatabase(factory);
  try {
    const writeTx = db.transaction([INTERPRETATIONS, CUSTOM_MEDIA], 'readwrite');
    const interpretationStore = writeTx.objectStore(INTERPRETATIONS);
    const mediaStore = writeTx.objectStore(CUSTOM_MEDIA);
    normalized.forEach(item => interpretationStore.put({ ...item, id: `${batchId}:${item.id}`, originalId: item.id, batchId }));
    media.forEach(item => mediaStore.put({ id: `${batchId}:${item.name}`, originalName: item.name, name: item.name, bytes: item.bytes, batchId }));
    await transactionDone(writeTx);
    const verifyTx = db.transaction([INTERPRETATIONS, CUSTOM_MEDIA], 'readonly');
    const verifiedInterpretations = await Promise.all(normalized.map(item => requestValue(verifyTx.objectStore(INTERPRETATIONS).get(`${batchId}:${item.id}`))));
    const verifiedMedia = await Promise.all(media.map(item => requestValue(verifyTx.objectStore(CUSTOM_MEDIA).get(`${batchId}:${item.name}`))));
    await transactionDone(verifyTx);
    if (verifiedInterpretations.some((record, index) => !record || record.batchId !== batchId || record.originalId !== normalized[index].id) ||
        verifiedMedia.some((record, index) => !record || record.batchId !== batchId || record.name !== media[index].name || record.bytes.byteLength !== media[index].bytes.byteLength || record.bytes.some((byte, offset) => byte !== media[index].bytes[offset]))) throw new Error('AUXILIARY_READBACK_MISMATCH');
    const pointerTx = db.transaction(META, 'readwrite');
    const meta = pointerTx.objectStore(META);
    meta.put({ key: 'activeInterpretationBatch', batchId });
    meta.put({ key: 'activeCustomMediaBatch', batchId });
    await transactionDone(pointerTx);
  } finally { db.close(); }
}

function validateArchiveName(name) {
  if (typeof name !== 'string' || name.includes('\\') || name.startsWith('/') || name.includes('\0')) return false;
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) return false;
  if (V5_FILES.has(name)) return true;
  return /^custom-media\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:png|jpe?g|webp)$/i.test(name);
}

function validateImage(name, bytes) {
  const extension = name.split('.').pop().toLowerCase();
  const signature = extension === 'png' ? IMAGE_SIGNATURES.png : extension === 'webp' ? IMAGE_SIGNATURES.webp : IMAGE_SIGNATURES.jpg;
  if (!bytesEqualPrefix(bytes, signature)) throw new Error('MEDIA_SIGNATURE_INVALID');
}

function decodeJson(bytes, anomaly) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (_) { throw new Error(anomaly); }
}

/** Create a v5 archive from a storage-key snapshot. The caller should offer it only after a user action. */
export async function createBackupV5(snapshot, options = {}) {
  const identifiedSnapshot = addStableIdentifiers(snapshot);
  const inspection = await inspectLegacySnapshot(identifiedSnapshot, options.validationOptions || {});
  if (!inspection.ok) {
    const error = new Error('SNAPSHOT_INVALID');
    error.anomalies = inspection.anomalies;
    throw error;
  }
  const { data, settings } = splitSnapshot(identifiedSnapshot);
  const interpretations = (options.legacyInterpretations || []).map(normalizeInterpretation);
  const dataBytes = utf8(canonical({ storage: data, legacyInterpretations: interpretations }));
  const settingsBytes = utf8(canonical(settings));
  const media = options.customMedia || [];
  if (!Array.isArray(media) || media.length > MAX_ENTRIES - 4) throw new Error('MEDIA_COUNT_INVALID');
  const mediaEntries = [];
  let mediaBytes = 0;
  for (const item of media) {
    if (!item || !validateArchiveName(item.name) || !item.name.startsWith('custom-media/')) throw new Error('MEDIA_NAME_INVALID');
    const bytes = item.bytes instanceof Uint8Array ? item.bytes : item.bytes instanceof Blob ? new Uint8Array(await item.bytes.arrayBuffer()) : null;
    if (!bytes || bytes.byteLength > MAX_ENTRY_BYTES) throw new Error('MEDIA_SIZE_INVALID');
    validateImage(item.name, bytes);
    mediaBytes += bytes.byteLength;
    if (mediaBytes > MAX_ARCHIVE_BYTES - dataBytes.byteLength - settingsBytes.byteLength) throw new Error('MEDIA_SIZE_INVALID');
    mediaEntries.push({ name: item.name, bytes });
  }
  if (new Set(mediaEntries.map(item => item.name)).size !== mediaEntries.length) throw new Error('MEDIA_DUPLICATE');
  const files = ['data.json', 'settings.json', ...mediaEntries.map(item => item.name)].sort();
  const checksummedBytes = { 'data.json': dataBytes, 'settings.json': settingsBytes };
  mediaEntries.forEach(item => { checksummedBytes[item.name] = item.bytes; });
  const checksums = {
    algorithm: 'SHA-256',
    files: Object.fromEntries(await Promise.all(Object.entries(checksummedBytes).map(async ([name, bytes]) => [name, await sha256Hex(bytes)])))
  };
  const manifest = {
    app: 'gymverse', version: 5, createdAt: options.createdAt || new Date().toISOString(),
    schema: 'legacy-storage-snapshot', files,
    counts: { ...inspection.counts, legacyInterpretations: interpretations.length }
  };
  const writer = new ZipWriter(new BlobWriter('application/zip'), { bufferedWrite: true });
  await writer.add('manifest.json', new TextReader(JSON.stringify(manifest)));
  await writer.add('data.json', new TextReader(new TextDecoder().decode(dataBytes)));
  await writer.add('settings.json', new TextReader(new TextDecoder().decode(settingsBytes)));
  for (const item of mediaEntries) await writer.add(item.name, new Uint8ArrayReader(item.bytes));
  await writer.add('checksums.json', new TextReader(JSON.stringify(checksums)));
  const blob = await writer.close();
  if (blob.size > MAX_ARCHIVE_BYTES) throw new Error('ARCHIVE_TOO_LARGE');
  return blob;
}

/** Parse and verify a ZIP v5 without touching browser storage; returned values stay in memory. */
export async function previewBackupV5(blob, validationOptions = {}) {
  if (!(blob instanceof Blob) || blob.size <= 0 || blob.size > MAX_ARCHIVE_BYTES) throw new Error('ARCHIVE_SIZE_INVALID');
  const reader = new ZipReader(new BlobReader(blob), { checkOverlappingEntry: true, filenameValidation: 'strict' });
  try {
    const entries = await reader.getEntries();
    if (!entries.length || entries.length > MAX_ENTRIES) throw new Error('ARCHIVE_ENTRY_COUNT_INVALID');
    const seen = new Set();
    const payloads = new Map();
    let total = 0;
    for (const entry of entries) {
      if (!validateArchiveName(entry.filename) || entry.directory || entry.encrypted || seen.has(entry.filename)) throw new Error('ARCHIVE_ENTRY_INVALID');
      seen.add(entry.filename);
      const size = entry.uncompressedSize;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) throw new Error('ARCHIVE_ENTRY_SIZE_INVALID');
      total += size;
      if (total > MAX_ARCHIVE_BYTES) throw new Error('ARCHIVE_EXPANDED_SIZE_INVALID');
    }
    for (const entry of entries) {
      const bytes = await entry.getData(new Uint8ArrayWriter());
      if (bytes.byteLength !== entry.uncompressedSize) throw new Error('ARCHIVE_ENTRY_SIZE_MISMATCH');
      if (entry.filename.startsWith('custom-media/')) validateImage(entry.filename, bytes);
      payloads.set(entry.filename, bytes);
    }
    for (const name of V5_FILES) if (!payloads.has(name)) throw new Error('ARCHIVE_REQUIRED_FILE_MISSING');
    const manifest = decodeJson(payloads.get('manifest.json'), 'MANIFEST_JSON_INVALID');
    const dataPayload = decodeJson(payloads.get('data.json'), 'DATA_JSON_INVALID');
    const settings = decodeJson(payloads.get('settings.json'), 'SETTINGS_JSON_INVALID');
    const checksums = decodeJson(payloads.get('checksums.json'), 'CHECKSUMS_JSON_INVALID');
    if (!isPlainObject(manifest) || manifest.app !== 'gymverse' || Number(manifest.version) !== 5 || manifest.schema !== 'legacy-storage-snapshot' || !Array.isArray(manifest.files) || !manifest.files.includes('data.json') || !manifest.files.includes('settings.json')) throw new Error('MANIFEST_INVALID');
    if (!isPlainObject(checksums) || checksums.algorithm !== 'SHA-256' || !isPlainObject(checksums.files)) throw new Error('CHECKSUMS_INVALID');
    const payloadNames = Array.from(payloads.keys()).filter(name => name !== 'manifest.json' && name !== 'checksums.json').sort();
    if (manifest.files.slice().sort().join(',') !== payloadNames.join(',') || Object.keys(checksums.files).sort().join(',') !== payloadNames.join(',')) throw new Error('CHECKSUMS_FILES_INVALID');
    for (const name of payloadNames) {
      if (!/^[a-f0-9]{64}$/.test(checksums.files[name]) || await sha256Hex(payloads.get(name)) !== checksums.files[name]) throw new Error('CHECKSUM_MISMATCH');
    }
    if (!isPlainObject(dataPayload) || !isPlainObject(dataPayload.storage) || Object.keys(dataPayload).some(key => !['storage', 'legacyInterpretations'].includes(key)) || !Array.isArray(dataPayload.legacyInterpretations)) throw new Error('DATA_SCHEMA_INVALID');
    const data = dataPayload.storage;
    if (Object.keys(data).some(key => !LEGACY_KEYS.has(key) || SETTINGS_KEYS.has(key))) throw new Error('DATA_SCHEMA_INVALID');
    if (!isPlainObject(settings) || Object.keys(settings).some(key => !SETTINGS_KEYS.has(key))) throw new Error('SETTINGS_SCHEMA_INVALID');
    const interpretations = dataPayload.legacyInterpretations.map(normalizeInterpretation);
    const snapshot = addStableIdentifiers({ ...data, ...settings });
    const inspection = await inspectLegacySnapshot(snapshot, validationOptions);
    if (!inspection.ok) {
      const error = new Error('BACKUP_DATA_INVALID');
      error.anomalies = inspection.anomalies;
      throw error;
    }
    const counts = { ...inspection.counts, legacyInterpretations: interpretations.length };
    if (manifest.counts && canonical(manifest.counts) !== canonical(counts)) throw new Error('MANIFEST_COUNTS_MISMATCH');
    const media = Array.from(payloads.entries()).filter(([name]) => name.startsWith('custom-media/')).map(([name, bytes]) => ({ name, bytes }));
    const mediaDigests = await Promise.all(media.map(async item => ({ name: item.name, sha256: await sha256Hex(item.bytes) })));
    return Object.freeze({ ok: true, version: 5, schema: manifest.schema, sha256: await sha256Hex(utf8(canonical({ snapshot, interpretations, media: mediaDigests }))), counts, schemaKeys: inspection.schemaKeys, snapshot, interpretations, media });
  } finally {
    await reader.close();
  }
}

/** Import v5 has an explicit confirmation gate and rollback verification. */
export async function restoreBackupV5(storage, preview, options = {}) {
  if (options.confirmed !== true) throw new Error('RESTORE_CONFIRMATION_REQUIRED');
  if (typeof options.restoreActive !== 'boolean' || typeof options.restoreDrafts !== 'boolean') throw new Error('RESTORE_SESSION_CHOICES_REQUIRED');
  if (!preview || preview.ok !== true || preview.version !== 5 || !isPlainObject(preview.snapshot)) throw new Error('RESTORE_PREVIEW_INVALID');
  const mediaDigests = await Promise.all((preview.media || []).map(async item => ({ name: item.name, sha256: await sha256Hex(item.bytes) })));
  if (await sha256Hex(utf8(canonical({ snapshot: preview.snapshot, interpretations: preview.interpretations || [], media: mediaDigests }))) !== preview.sha256) throw new Error('RESTORE_PREVIEW_CHANGED');
  const inspected = { ...preview.snapshot };
  if (!options.restoreActive) delete inspected.gymverse_active;
  else if (inspected.gymverse_active) inspected.gymverse_active = sanitizeRestoredActive(inspected.gymverse_active);
  if (!options.restoreDrafts) delete inspected.gymverse_draft_v1;
  const validation = await inspectLegacySnapshot(inspected, options.validationOptions || {});
  if (!validation.ok) {
    const error = new Error('RESTORE_DATA_INVALID');
    error.anomalies = validation.anomalies;
    throw error;
  }
  const keys = Array.from(LEGACY_KEYS);
  const runtime = storage && storage.__gymverseRuntimeStore;
  if (runtime && runtime.mode === 'indexeddb') {
    const updates = Object.fromEntries(keys.map(key => [key, Object.hasOwn(inspected, key) ? inspected[key] : null]));
    return runtime.restoreSnapshot(updates, { interpretations: preview.interpretations || [], media: preview.media || [], batchId: preview.sha256 });
  }
  const before = new Map(keys.map(key => [key, storage.getItem(key)]));
  const attempted = [];
  try {
    for (const key of keys) {
      const hasValue = Object.hasOwn(inspected, key);
      const value = hasValue ? JSON.stringify(inspected[key]) : null;
      attempted.push(key);
      if (value === null) storage.removeItem(key); else storage.setItem(key, value);
      if (storage.getItem(key) !== value) throw new Error('RESTORE_READBACK_FAILED');
    }
    const indexedDBFactory = options.indexedDB || globalThis.indexedDB;
    if (indexedDBFactory) await replaceAuxiliaryBatch(preview.interpretations || [], preview.media || [], preview.sha256, indexedDBFactory);
    else if ((preview.interpretations && preview.interpretations.length) || (preview.media && preview.media.length)) throw new Error('INDEXEDDB_UNSUPPORTED');
    return { status: 'restored', keys: Object.keys(inspected).length, interpretations: (preview.interpretations || []).length };
  } catch (error) {
    error.rollbackErrors = [];
    for (const key of attempted.reverse()) {
      try {
        const previous = before.get(key);
        if (previous === null) storage.removeItem(key); else storage.setItem(key, previous);
        if (storage.getItem(key) !== previous) throw new Error('RESTORE_ROLLBACK_MISMATCH');
      } catch (rollbackError) { error.rollbackErrors.push(rollbackError); }
    }
    if (error.rollbackErrors.length) error.integrityUncertain = true;
    throw error;
  }
}
