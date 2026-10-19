import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
export const migration = {
    version: 8,
    name: 'normalize_turn_ingress',
    up: normalizeTurnIngress,
};
/**
 * Frozen ingress convergence.
 *
 * The global runner owns the surrounding transaction. Sequence mappings are a repairable
 * projection: corrupt/stale/orphan rows are rebuilt from the receipt table, but a main-table
 * sequence is preserved only when it is a positive safe integer, globally unique, and compatible
 * with the existing mapping for the same turn. Client request values carry durable external
 * identities, so source/capacity/cross-turn conflicts fail closed; only their ordinal projection
 * is rebuilt into a stable, contiguous order.
 */
function normalizeTurnIngress(database) {
    const ingressRows = readAndValidateIngress(database);
    const descriptorPlan = buildDescriptorPlan(ingressRows);
    const sequencePlan = buildSequencePlan(database, ingressRows);
    const clientRequestPlan = buildClientRequestPlan(database, ingressRows);
    applyDescriptorPlan(database, descriptorPlan);
    applySequencePlan(database, sequencePlan);
    applyClientRequestPlan(database, clientRequestPlan);
    assertPostconditions(database, sequencePlan.historicalHighWater);
}
function readAndValidateIngress(database) {
    const rawRows = database
        .prepare(`SELECT turn_id, session_id, source, client_request_id,
              claim_id, claim_source, queue_item_ids_json, input_json, status,
              accepted_at_ms, accepted_sequence, completed_at_ms,
              queue_acknowledged_at_ms, input_digest, input_metadata_json
       FROM local_runtime_turn_ingress
       ORDER BY rowid ASC, turn_id ASC`)
        .all();
    const turnIds = new Set();
    const claimIds = new Set();
    return rawRows.map((row) => {
        const turnId = nonEmptyString(row.turn_id, 'ingress turn identity');
        const sessionId = nonEmptyString(row.session_id, `ingress session identity for ${turnId}`);
        if (turnIds.has(turnId))
            throw new Error(`Duplicate ingress turn identity: ${turnId}`);
        turnIds.add(turnId);
        const source = parseSource(row.source, turnId);
        const status = parseStatus(row.status, turnId);
        const clientRequestId = optionalIdentity(row.client_request_id, `ingress client request identity for ${turnId}`);
        const claimId = optionalIdentity(row.claim_id, `ingress claim identity for ${turnId}`);
        const claimSource = optionalIdentity(row.claim_source, `ingress claim source for ${turnId}`);
        const queueItemIdsJson = optionalString(row.queue_item_ids_json, `ingress queue item JSON for ${turnId}`);
        validateClaimScope({ turnId, source, claimId, claimSource, queueItemIdsJson });
        if (claimId) {
            if (claimIds.has(claimId))
                throw new Error(`Duplicate ingress claim identity: ${claimId}`);
            claimIds.add(claimId);
        }
        const completedAtMs = optionalUnixMs(row.completed_at_ms, `ingress completed time for ${turnId}`);
        const queueAcknowledgedAtMs = optionalUnixMs(row.queue_acknowledged_at_ms, `ingress queue acknowledgement time for ${turnId}`);
        validateReceiptLifecycle({
            turnId,
            source,
            status,
            completedAtMs,
            queueAcknowledgedAtMs,
        });
        return {
            turnId,
            sessionId,
            source,
            clientRequestId,
            claimId,
            claimSource,
            queueItemIdsJson,
            inputJson: requiredString(row.input_json, `ingress input JSON for ${turnId}`),
            status,
            acceptedAtMs: unixMs(row.accepted_at_ms, `ingress accepted time for ${turnId}`),
            acceptedSequence: row.accepted_sequence,
            completedAtMs,
            queueAcknowledgedAtMs,
            inputDigest: optionalString(row.input_digest, `ingress input digest for ${turnId}`),
            inputMetadataJson: requiredString(row.input_metadata_json, `ingress input metadata JSON for ${turnId}`),
        };
    });
}
function validateReceiptLifecycle(input) {
    if (input.status === 'accepted') {
        if (input.completedAtMs !== null) {
            throw new Error(`Accepted receipt has a completion time for ${input.turnId}`);
        }
        if (input.source !== 'dispatcher' && input.queueAcknowledgedAtMs !== null) {
            throw new Error(`Non-dispatcher receipt has a queue acknowledgement for ${input.turnId}`);
        }
        return;
    }
    if (input.completedAtMs === null) {
        throw new Error(`Terminal receipt lacks a completion time for ${input.turnId}`);
    }
    if (input.source !== 'dispatcher' || input.queueAcknowledgedAtMs !== null) {
        throw new Error(`Impossible persisted receipt lifecycle for ${input.turnId}`);
    }
}
function parseSource(value, turnId) {
    if (value === 'send' ||
        value === 'dispatcher' ||
        value === 'compaction' ||
        value === 'rotation') {
        return value;
    }
    throw new Error(`Invalid ingress source for ${turnId}`);
}
function parseStatus(value, turnId) {
    if (value === 'accepted' || value === 'completed' || value === 'failed' || value === 'aborted') {
        return value;
    }
    throw new Error(`Invalid ingress status for ${turnId}`);
}
function validateClaimScope(input) {
    if (input.source !== 'dispatcher') {
        if (hasClaimScope(input))
            throw new Error(`Invalid ingress claim scope for ${input.turnId}`);
        return;
    }
    if (!input.claimId || !input.claimSource || input.queueItemIdsJson === null) {
        throw new Error(`Dispatcher ingress is missing claim identity for ${input.turnId}`);
    }
    validateQueueItemIds(input.queueItemIdsJson, input.turnId);
}
function hasClaimScope(input) {
    return input.claimId !== null || input.claimSource !== null || input.queueItemIdsJson !== null;
}
function validateQueueItemIds(raw, turnId) {
    const itemIds = parseJson(raw, `ingress queue item JSON for ${turnId}`);
    if (!Array.isArray(itemIds) ||
        itemIds.length === 0 ||
        itemIds.some((itemId) => typeof itemId !== 'string' || itemId.trim().length === 0) ||
        new Set(itemIds).size !== itemIds.length) {
        throw new Error(`Invalid ingress queue item identities for ${turnId}`);
    }
}
function buildDescriptorPlan(rows) {
    return rows.map((row) => {
        const parsed = parseInput(row.inputJson, row.turnId);
        const computed = describeInput(parsed);
        const existingDigest = parseExistingDigest(row.inputDigest, row.turnId);
        const existingMetadata = parseExistingMetadata(row.inputMetadataJson, row.turnId);
        const alreadyScrubbed = Object.keys(parsed).length === 0;
        if (alreadyScrubbed && existingDigest && existingMetadata) {
            return { turnId: row.turnId, digest: existingDigest, metadata: existingMetadata };
        }
        if (existingDigest && existingDigest !== computed.digest) {
            throw new Error(`Ingress input digest conflicts with input for ${row.turnId}`);
        }
        if (existingMetadata && !sameMetadata(existingMetadata, computed.metadata)) {
            throw new Error(`Ingress input metadata conflicts with input for ${row.turnId}`);
        }
        return { turnId: row.turnId, ...computed };
    });
}
function parseInput(raw, turnId) {
    const value = parseJson(raw, `ingress input for ${turnId}`);
    if (!isPlainRecord(value))
        throw new Error(`Ingress input must be a plain object for ${turnId}`);
    assertJsonValue(value, `ingress input for ${turnId}`);
    if ('content' in value && typeof value.content !== 'string') {
        throw new Error(`Ingress input content must be a string for ${turnId}`);
    }
    if ('attachments' in value && !Array.isArray(value.attachments)) {
        throw new Error(`Ingress input attachments must be an array for ${turnId}`);
    }
    if ('queuedMessages' in value && !Array.isArray(value.queuedMessages)) {
        throw new Error(`Ingress input queuedMessages must be an array for ${turnId}`);
    }
    return value;
}
function describeInput(input) {
    const canonical = JSON.stringify(sortJson(input));
    const attachments = input.attachments;
    const queuedMessages = input.queuedMessages;
    return {
        digest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
        metadata: {
            contentBytes: Buffer.byteLength(input.content ?? '', 'utf8'),
            attachmentCount: attachments?.length ?? 0,
            queuedMessageCount: queuedMessages?.length ?? 0,
            hasModelSelection: input.model !== undefined,
            hasChannelContext: input.channelContext !== undefined,
            hasQuotedMessage: input.quotedMessage !== undefined,
        },
    };
}
function assertJsonValue(value, label) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error(`${label} contains a non-finite number`);
        return;
    }
    if (Array.isArray(value)) {
        assertJsonArray(value, label);
        return;
    }
    if (!isPlainRecord(value))
        throw new Error(`${label} contains a non-plain object`);
    assertJsonRecord(value, label);
}
function assertJsonArray(value, label) {
    for (let index = 0; index < value.length; index += 1) {
        if (!(index in value))
            throw new Error(`${label} contains a sparse array`);
        assertJsonValue(value[index], label);
    }
}
function assertJsonRecord(value, label) {
    for (const entry of Object.values(value))
        assertJsonValue(entry, label);
}
function sortJson(value) {
    if (Array.isArray(value))
        return value.map((entry) => sortJson(entry));
    if (!isPlainRecord(value))
        return value;
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort())
        sorted[key] = sortJson(value[key]);
    return sorted;
}
const METADATA_KEYS = [
    'contentBytes',
    'attachmentCount',
    'queuedMessageCount',
    'hasModelSelection',
    'hasChannelContext',
    'hasQuotedMessage',
];
const SORTED_METADATA_KEYS = [...METADATA_KEYS].sort();
function parseExistingDigest(raw, turnId) {
    if (raw === null || raw.trim().length === 0)
        return undefined;
    if (!/^sha256:[a-f0-9]{64}$/.test(raw)) {
        throw new Error(`Invalid ingress input digest for ${turnId}`);
    }
    return raw;
}
function parseExistingMetadata(raw, turnId) {
    if (raw.trim().length === 0)
        return undefined;
    const value = parseJson(raw, `ingress input metadata for ${turnId}`);
    if (isPlainRecord(value) && Object.keys(value).length === 0)
        return undefined;
    if (!isPlainRecord(value))
        throw new Error(`Invalid ingress input metadata for ${turnId}`);
    if (!hasExactMetadataShape(value)) {
        throw new Error(`Invalid ingress input metadata for ${turnId}`);
    }
    return {
        contentBytes: value.contentBytes,
        attachmentCount: value.attachmentCount,
        queuedMessageCount: value.queuedMessageCount,
        hasModelSelection: value.hasModelSelection,
        hasChannelContext: value.hasChannelContext,
        hasQuotedMessage: value.hasQuotedMessage,
    };
}
function hasExactMetadataShape(value) {
    return hasExactMetadataKeys(value) && hasMetadataCounts(value) && hasMetadataFlags(value);
}
function hasExactMetadataKeys(value) {
    const keys = Object.keys(value).sort();
    return (keys.length === SORTED_METADATA_KEYS.length &&
        keys.every((key, index) => key === SORTED_METADATA_KEYS[index]));
}
function hasMetadataCounts(value) {
    return (nonNegativeSafeInteger(value.contentBytes) &&
        nonNegativeSafeInteger(value.attachmentCount) &&
        nonNegativeSafeInteger(value.queuedMessageCount));
}
function hasMetadataFlags(value) {
    return (typeof value.hasModelSelection === 'boolean' &&
        typeof value.hasChannelContext === 'boolean' &&
        typeof value.hasQuotedMessage === 'boolean');
}
function sameMetadata(left, right) {
    return METADATA_KEYS.every((key) => left[key] === right[key]);
}
function applyDescriptorPlan(database, plan) {
    const update = database.prepare(`UPDATE local_runtime_turn_ingress
     SET input_json = '{}', input_digest = ?, input_metadata_json = ?
     WHERE turn_id = ?`);
    for (const descriptor of plan) {
        update.run(descriptor.digest, JSON.stringify(descriptor.metadata), descriptor.turnId);
    }
}
function buildSequencePlan(database, ingressRows) {
    const mappingRows = database
        .prepare(`SELECT sequence, turn_id
       FROM local_runtime_turn_ingress_sequences
       ORDER BY sequence ASC, turn_id ASC`)
        .all();
    const mappings = mappingRows.flatMap((row) => {
        const sequence = row.sequence;
        if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) {
            throw new Error('Ingress sequence mapping exceeds the safe integer range');
        }
        if (sequence <= 0)
            return [];
        return [
            {
                sequence,
                turnId: requiredString(row.turn_id, 'ingress sequence mapping turn identity'),
            },
        ];
    });
    const sqliteHighWater = readSqliteSequence(database);
    assertMainSequenceRange(ingressRows);
    const validMainSequences = ingressRows.flatMap((row) => isPositiveSafeInteger(row.acceptedSequence) ? [row.acceptedSequence] : []);
    const historicalHighWater = maximum([...validMainSequences, ...mappings.map(({ sequence }) => sequence)], sqliteHighWater);
    if (historicalHighWater >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Ingress sequence history exhausted the safe integer range');
    }
    const mainCounts = frequency(validMainSequences);
    const mappingByTurn = groupBy(mappings, ({ turnId }) => turnId);
    const mappingBySequence = groupBy(mappings, ({ sequence }) => sequence);
    let nextSequence = historicalHighWater;
    const assignments = [];
    for (const row of ingressRows) {
        if (canPreserveSequence(row, mainCounts, mappingByTurn, mappingBySequence)) {
            assignments.push({ turnId: row.turnId, sequence: row.acceptedSequence });
            continue;
        }
        if (nextSequence >= Number.MAX_SAFE_INTEGER) {
            throw new Error('Ingress sequence history exhausted the safe integer range');
        }
        nextSequence += 1;
        assignments.push({ turnId: row.turnId, sequence: nextSequence });
    }
    return { assignments, historicalHighWater };
}
function assertMainSequenceRange(rows) {
    const hasUnsafePositive = rows.some(({ acceptedSequence }) => typeof acceptedSequence === 'number' &&
        acceptedSequence > 0 &&
        !Number.isSafeInteger(acceptedSequence));
    if (hasUnsafePositive) {
        throw new Error('Ingress sequence history exceeds the safe integer range');
    }
}
function canPreserveSequence(row, mainCounts, mappingByTurn, mappingBySequence) {
    const candidate = row.acceptedSequence;
    if (!isPositiveSafeInteger(candidate) || mainCounts.get(candidate) !== 1)
        return false;
    return (mappingMatchesTurn(mappingByTurn.get(row.turnId) ?? [], candidate) &&
        mappingMatchesSequence(mappingBySequence.get(candidate) ?? [], row.turnId));
}
function mappingMatchesTurn(mappings, sequence) {
    return mappings.length === 0 || (mappings.length === 1 && mappings[0]?.sequence === sequence);
}
function mappingMatchesSequence(mappings, turnId) {
    return mappings.length === 0 || (mappings.length === 1 && mappings[0]?.turnId === turnId);
}
function readSqliteSequence(database) {
    const rows = database
        .prepare(`SELECT seq
       FROM sqlite_sequence
       WHERE name = 'local_runtime_turn_ingress_sequences'`)
        .all();
    if (rows.length === 0)
        return 0;
    if (rows.length !== 1 || !nonNegativeSafeInteger(rows[0]?.seq)) {
        throw new Error('Invalid ingress allocator high-water mark');
    }
    return rows[0].seq;
}
function applySequencePlan(database, plan) {
    database.exec(`
    DROP INDEX IF EXISTS idx_local_runtime_turn_ingress_sequence;
    DROP INDEX IF EXISTS local_runtime_turn_ingress_sequences_turn_id;
    UPDATE local_runtime_turn_ingress SET accepted_sequence = NULL;
    DELETE FROM local_runtime_turn_ingress_sequences;
  `);
    const insertMapping = database.prepare(`INSERT INTO local_runtime_turn_ingress_sequences(sequence, turn_id)
     VALUES (?, ?)`);
    const updateIngress = database.prepare(`UPDATE local_runtime_turn_ingress
     SET accepted_sequence = ?
     WHERE turn_id = ?`);
    for (const assignment of plan.assignments) {
        insertMapping.run(assignment.sequence, assignment.turnId);
        updateIngress.run(assignment.sequence, assignment.turnId);
    }
    const finalHighWater = maximum(plan.assignments.map(({ sequence }) => sequence), plan.historicalHighWater);
    setSqliteSequence(database, finalHighWater);
    database.exec(`
    CREATE UNIQUE INDEX idx_local_runtime_turn_ingress_sequence
      ON local_runtime_turn_ingress(accepted_sequence)
      WHERE accepted_sequence IS NOT NULL;
    CREATE UNIQUE INDEX local_runtime_turn_ingress_sequences_turn_id
      ON local_runtime_turn_ingress_sequences(turn_id);
  `);
}
function setSqliteSequence(database, highWater) {
    const present = database
        .prepare(`SELECT 1 AS present
       FROM sqlite_sequence
       WHERE name = 'local_runtime_turn_ingress_sequences'`)
        .all().length;
    if (present > 0) {
        database
            .prepare(`UPDATE sqlite_sequence
         SET seq = ?
         WHERE name = 'local_runtime_turn_ingress_sequences'`)
            .run(highWater);
    }
    else if (highWater > 0) {
        database
            .prepare(`INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)`)
            .run('local_runtime_turn_ingress_sequences', highWater);
    }
}
function buildClientRequestPlan(database, ingressRows) {
    const ingressByTurn = new Map(ingressRows.map((row) => [row.turnId, row]));
    const mappings = readClientRequestMappings(database, ingressByTurn);
    assertUniqueClientIdentities(mappings);
    assertUniquePrimaryClientRequests(ingressRows);
    assertPrimaryMappingOwnership(ingressRows, mappings);
    const mappingsByTurn = groupBy(mappings, ({ turnId }) => turnId);
    const normalized = [];
    for (const ingress of ingressRows) {
        normalized.push(...normalizeTurnClientRequests(ingress, mappingsByTurn.get(ingress.turnId) ?? []));
    }
    assertUniqueClientIdentities(normalized);
    return normalized.sort(compareClientRequestMappings);
}
function readClientRequestMappings(database, ingressByTurn) {
    const rawRows = database
        .prepare(`SELECT session_id, client_request_id, turn_id, ordinal
       FROM local_runtime_turn_ingress_client_requests
       ORDER BY turn_id ASC, ordinal ASC, client_request_id ASC`)
        .all();
    return rawRows.map((row) => parseClientRequestMapping(row, ingressByTurn));
}
function parseClientRequestMapping(row, ingressByTurn) {
    const turnId = nonEmptyString(row.turn_id, 'client request mapping turn identity');
    const ingress = ingressByTurn.get(turnId);
    if (!ingress)
        throw new Error(`Client request mapping references missing turn: ${turnId}`);
    const sessionId = nonEmptyString(row.session_id, `client request mapping session identity for ${turnId}`);
    if (sessionId !== ingress.sessionId) {
        throw new Error(`Client request mapping session conflicts with turn ${turnId}`);
    }
    return {
        sessionId,
        clientRequestId: nonEmptyString(row.client_request_id, `client request identity for ${turnId}`),
        turnId,
        ordinal: nonNegativeSafeIntegerRequired(row.ordinal, `client request ordinal for ${turnId}`),
    };
}
function assertUniquePrimaryClientRequests(ingressRows) {
    const primaryByIdentity = new Map();
    for (const row of ingressRows) {
        if (!row.clientRequestId)
            continue;
        const identity = clientIdentity(row.sessionId, row.clientRequestId);
        const existingTurn = primaryByIdentity.get(identity);
        if (existingTurn && existingTurn !== row.turnId) {
            throw new Error(`Client request identity conflicts across turns: ${row.clientRequestId}`);
        }
        primaryByIdentity.set(identity, row.turnId);
    }
}
function assertPrimaryMappingOwnership(ingressRows, mappings) {
    const mappingByIdentity = new Map(mappings.map((mapping) => [
        clientIdentity(mapping.sessionId, mapping.clientRequestId),
        mapping,
    ]));
    for (const ingress of ingressRows) {
        if (!ingress.clientRequestId)
            continue;
        const mapping = mappingByIdentity.get(clientIdentity(ingress.sessionId, ingress.clientRequestId));
        if (mapping && mapping.turnId !== ingress.turnId) {
            throw new Error(`Client request identity maps to another turn: ${ingress.clientRequestId}`);
        }
    }
}
function normalizeTurnClientRequests(ingress, existing) {
    const ordered = [...existing].sort(compareExistingClientRequestOrder);
    assertSourceAwareIdentityContract(ingress, ordered);
    const primary = findPrimaryClientRequest(ingress, ordered) ?? createPrimaryClientRequest(ingress);
    const finalOrder = primary
        ? [primary, ...ordered.filter((mapping) => mapping !== primary)]
        : ordered;
    return finalOrder.map((mapping, ordinal) => ({ ...mapping, ordinal }));
}
function assertSourceAwareIdentityContract(ingress, mappings) {
    if (ingress.source !== 'dispatcher') {
        assertDirectIdentityContract(ingress, mappings);
        return;
    }
    const hasPrimary = findPrimaryClientRequest(ingress, mappings) !== undefined;
    const normalizedCount = mappings.length + (ingress.clientRequestId && !hasPrimary ? 1 : 0);
    const queueItemCount = readQueueItemIds(ingress).length;
    if (normalizedCount > queueItemCount) {
        throw new Error(`Dispatcher durable identity count exceeds queue items for ${ingress.turnId}`);
    }
}
function assertDirectIdentityContract(ingress, mappings) {
    if (!ingress.clientRequestId) {
        if (mappings.length > 0) {
            throw new Error(`Non-dispatcher receipt has an extra durable identity for ${ingress.turnId}`);
        }
        return;
    }
    if (mappings.length > 1 ||
        (mappings.length === 1 && mappings[0]?.clientRequestId !== ingress.clientRequestId)) {
        throw new Error(`Non-dispatcher client request identity conflicts for ${ingress.turnId}`);
    }
}
function findPrimaryClientRequest(ingress, mappings) {
    if (!ingress.clientRequestId)
        return undefined;
    return mappings.find(({ sessionId, clientRequestId }) => sessionId === ingress.sessionId && clientRequestId === ingress.clientRequestId);
}
function createPrimaryClientRequest(ingress) {
    if (!ingress.clientRequestId)
        return undefined;
    return {
        sessionId: ingress.sessionId,
        clientRequestId: ingress.clientRequestId,
        turnId: ingress.turnId,
        ordinal: 0,
    };
}
function readQueueItemIds(ingress) {
    if (ingress.queueItemIdsJson === null) {
        throw new Error(`Dispatcher ingress lacks queue item identities for ${ingress.turnId}`);
    }
    const value = parseJson(ingress.queueItemIdsJson, `ingress queue item JSON for ${ingress.turnId}`);
    if (!Array.isArray(value))
        throw new Error(`Invalid queue item identities for ${ingress.turnId}`);
    return value;
}
function compareExistingClientRequestOrder(left, right) {
    return (left.ordinal - right.ordinal || compareStrings(left.clientRequestId, right.clientRequestId));
}
function compareClientRequestMappings(left, right) {
    return (compareStrings(left.turnId, right.turnId) ||
        left.ordinal - right.ordinal ||
        compareStrings(left.clientRequestId, right.clientRequestId));
}
function assertUniqueClientIdentities(mappings) {
    const identities = new Set();
    for (const mapping of mappings) {
        const identity = clientIdentity(mapping.sessionId, mapping.clientRequestId);
        if (identities.has(identity)) {
            throw new Error(`Duplicate client request identity: ${mapping.clientRequestId}`);
        }
        identities.add(identity);
    }
}
function applyClientRequestPlan(database, mappings) {
    database.exec('DELETE FROM local_runtime_turn_ingress_client_requests;');
    const insert = database.prepare(`INSERT INTO local_runtime_turn_ingress_client_requests(
       session_id, client_request_id, turn_id, ordinal
     ) VALUES (?, ?, ?, ?)`);
    for (const mapping of mappings) {
        insert.run(mapping.sessionId, mapping.clientRequestId, mapping.turnId, mapping.ordinal);
    }
}
function assertPostconditions(database, historicalHighWater) {
    const rows = readAndValidateIngress(database);
    const sequenceByTurn = readSequencePostconditions(database, rows.length);
    const assigned = assertIngressPostconditions(rows, sequenceByTurn);
    assertAllocatorPostcondition(database, historicalHighWater, assigned);
    assertClientRequestPostconditions(database, rows);
}
function readSequencePostconditions(database, ingressCount) {
    const sequences = database
        .prepare(`SELECT sequence, turn_id
       FROM local_runtime_turn_ingress_sequences
       ORDER BY sequence ASC`)
        .all();
    if (sequences.length !== ingressCount)
        throw new Error('Ingress sequence projection is incomplete');
    const sequenceByTurn = new Map();
    for (const raw of sequences) {
        const sequence = positiveSafeInteger(raw.sequence, 'ingress sequence postcondition');
        const turnId = nonEmptyString(raw.turn_id, 'ingress sequence postcondition turn');
        if (sequenceByTurn.has(turnId))
            throw new Error('Ingress sequence projection is not one-to-one');
        sequenceByTurn.set(turnId, sequence);
    }
    return sequenceByTurn;
}
function assertIngressPostconditions(rows, sequenceByTurn) {
    const assigned = new Set();
    for (const row of rows) {
        assertIngressSequencePostcondition(row, sequenceByTurn, assigned);
        assertIngressDescriptorPostcondition(row);
    }
    return assigned;
}
function assertIngressSequencePostcondition(row, sequenceByTurn, assigned) {
    if (!isPositiveSafeInteger(row.acceptedSequence)) {
        throw new Error(`Ingress sequence is invalid for ${row.turnId}`);
    }
    if (assigned.has(row.acceptedSequence))
        throw new Error('Ingress sequences are not unique');
    assigned.add(row.acceptedSequence);
    if (sequenceByTurn.get(row.turnId) !== row.acceptedSequence) {
        throw new Error(`Ingress sequence projection conflicts for ${row.turnId}`);
    }
}
function assertIngressDescriptorPostcondition(row) {
    if (row.inputJson !== '{}')
        throw new Error(`Ingress input was not scrubbed for ${row.turnId}`);
    parseExistingDigest(row.inputDigest, row.turnId);
    if (!parseExistingMetadata(row.inputMetadataJson, row.turnId)) {
        throw new Error(`Ingress input metadata is missing for ${row.turnId}`);
    }
}
function assertAllocatorPostcondition(database, historicalHighWater, assigned) {
    const maxAssigned = maximum(assigned, 0);
    if (readSqliteSequence(database) < Math.max(historicalHighWater, maxAssigned)) {
        throw new Error('Ingress allocator high-water mark regressed');
    }
}
function assertClientRequestPostconditions(database, ingressRows) {
    const ingressByTurn = new Map(ingressRows.map((row) => [row.turnId, row]));
    const mappings = readClientRequestMappings(database, ingressByTurn);
    assertUniqueClientIdentities(mappings);
    const mappingsByTurn = groupBy(mappings, ({ turnId }) => turnId);
    for (const ingress of ingressRows) {
        const turnMappings = mappingsByTurn.get(ingress.turnId) ?? [];
        assertSourceAwareIdentityContract(ingress, turnMappings);
        assertContinuousClientRequestOrdinals(ingress.turnId, turnMappings);
        if (ingress.clientRequestId && turnMappings[0]?.clientRequestId !== ingress.clientRequestId) {
            throw new Error(`Primary client request mapping is incomplete for ${ingress.turnId}`);
        }
    }
}
function assertContinuousClientRequestOrdinals(turnId, mappings) {
    const ordered = [...mappings].sort(compareClientRequestMappings);
    if (ordered.some(({ ordinal }, index) => ordinal !== index)) {
        throw new Error(`Client request ordinals are not continuous for ${turnId}`);
    }
}
function parseJson(raw, label) {
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`Invalid ${label} JSON`, { cause: error });
    }
}
function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function requiredString(value, label) {
    if (typeof value !== 'string')
        throw new Error(`${label} must be a string`);
    return value;
}
function nonEmptyString(value, label) {
    const parsed = requiredString(value, label);
    if (parsed.trim().length === 0)
        throw new Error(`${label} must be non-empty`);
    return parsed;
}
function optionalString(value, label) {
    if (value === null)
        return null;
    return requiredString(value, label);
}
function optionalIdentity(value, label) {
    if (value === null)
        return null;
    return nonEmptyString(value, label);
}
function unixMs(value, label) {
    if (!nonNegativeSafeInteger(value))
        throw new Error(`${label} must be a Unix ms integer`);
    return value;
}
function optionalUnixMs(value, label) {
    if (value === null)
        return null;
    return unixMs(value, label);
}
function positiveSafeInteger(value, label) {
    if (!isPositiveSafeInteger(value))
        throw new Error(`${label} must be a positive safe integer`);
    return value;
}
function nonNegativeSafeIntegerRequired(value, label) {
    if (!nonNegativeSafeInteger(value))
        throw new Error(`${label} must be a non-negative integer`);
    return value;
}
function isPositiveSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function nonNegativeSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function frequency(values) {
    const counts = new Map();
    for (const value of values)
        counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
}
function maximum(values, initial) {
    let result = initial;
    for (const value of values) {
        if (value > result)
            result = value;
    }
    return result;
}
function groupBy(values, keyOf) {
    const groups = new Map();
    for (const value of values) {
        const key = keyOf(value);
        const group = groups.get(key);
        if (group)
            group.push(value);
        else
            groups.set(key, [value]);
    }
    return groups;
}
function clientIdentity(sessionId, clientRequestId) {
    return JSON.stringify([sessionId, clientRequestId]);
}
function compareStrings(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
//# sourceMappingURL=migration-0008-normalize-turn-ingress.js.map