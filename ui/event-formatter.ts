import IOEvent from '../ioevent';

function formatEvent(event: IOEvent): string {
    const d = event.data;
    switch (event.type) {
        case 'starting_migration':
            return `starting migration: ${JSON.stringify(d?.options)}`;
        case 'describing_sobject':
            return `describing SObject ${d?.sObjectName}`;
        case 'checking_matchers':
            return 'checking matchers';
        case 'records_so_far':
            return `records so far: ${d?.count}`;
        case 'fetching_record': {
            const reasonText = d?.reason ? ` (via ${d.reason})` : '';
            return `fetching record ${d?.recordId} of type ${d?.sObjectName}${reasonText}`;
        }
        case 'record_not_found':
            return `record ${d?.recordId} of type ${d?.sObjectName} does not exist in the source org`;
        case 'record_not_queryable':
            return `record ${d?.recordId} of type ${d?.sObjectName} is not queryable`;
        case 'malformed_id':
            return `record ${d?.recordId} of type ${d?.sObjectName} is malformed`;
        case 'querying_related_records':
            return `querying for related records: ${d?.soql}`;
        case 'related_records':
            return `related records of ${d?.relationshipName}: ${d?.count}`;
        case 'fetched_records':
            return `fetched ${d?.count} records`;
        case 'confirm_migration':
            return formatConfirmMigration(d);
        case 'aborted':
            return 'aborted';
        case 'confirmation':
            return `confirmation: ${d?.confirmation}`;
        case 'finished':
            return formatFinished(d);
        case 'remaining_records':
            return `remaining records: ${d?.count}`;
        case 'querying_existing_record':
            return `querying for existing record: ${d?.soql}`;
        case 'found_existing_record':
            return `found existing record ${d?.recordId} of type ${d?.sObjectName}`;
        case 'skipping_record':
            return `skipping record ${d?.recordId} of type ${d?.sObjectName} because no existing record was found`;
        case 'mapping':
            return `mapping ${d?.field} to ${d?.match} for record ${d?.newRecordId} of type ${d?.sObjectName} - new value: ${d?.newValue}`;
        case 'creating_record':
            return `creating record ${d?.recordId} of type ${d?.sObjectName} with fields ${JSON.stringify(d?.record)}`;
        case 'saving_records': {
            const records = d?.records || [];
            const typeCounts = formatTypeCounts(d?.recordCountsByType);
            let jsonStr = JSON.stringify(records);
            if (jsonStr.length > 1000) {
                jsonStr = jsonStr.substring(0, 1000) + '...';
            }
            return `saving ${records.length} records (${typeCounts}): ${jsonStr}`;
        }
        case 'saved_records':
            return `saved records: ${JSON.stringify(d)}`;
        case 'created_record':
            return `created record ${d?.recordId}`;
        case 'skipping_previously_used_solvers':
            return `skipping previously used solvers: ${JSON.stringify(d?.usedSolvers)}`;
        case 'using_solver': {
            switch (d?.solverAction) {
                case 'match':
                    return `matching record ${d?.recordId} using solver: ${d?.solver}`;
                case 'skip':
                    return `skipping record ${d?.recordId} using solver: ${d?.solver}`;
                case 'extract_column':
                    return `extracting column name from error: ${d?.error}`;
                case 'append_random':
                    return `appending random to record ${d?.recordId} using solver: ${d?.solver}`;
                default:
                    return `fixing using solver: ${d?.solverMessage}`;
            }
        }
        case 'saved_old_fields':
            return `saved old fields in toUpdateLater: ${JSON.stringify(d?.oldFields)}`;
        case 'error':
            return `error: ${d?.message}`;
        case 'insert_error': {
            if (d?.recordId && d?.error) {
                const options = [
                    { key: 'f', label: 'Fix' },
                    { key: 'r', label: 'Retry' },
                    { key: 'ra', label: 'Retry All' },
                    { key: 'm', label: 'Match' },
                    { key: 'h', label: 'Save and Exit' },
                    { key: 'a', label: 'Add Solver' },
                    { key: 's', label: 'Skip' }
                ];
                const optionsList = options.map(opt => `- ${opt.label} (${opt.key})`).join('\n');
                return `recordId: ${d.recordId}, no solver found for error: ${d.error}\nPlease provide input to resolve the error:\nAvailable options:\n${optionsList}:`;
            }
            return `Enter input:`;
        }
        case 'invalid_json':
            return 'invalid JSON, please try again';
        case 'invalid_regex':
            return 'invalid regex, please try again';
        case 'invalid_input':
            return `invalid input: ${d?.input}`;
        case 'looking_for_circular_dependencies':
            return `looking for circular dependencies with ${JSON.stringify(d?.requiredLookupFieldsBySObjectType)} for records ${JSON.stringify(d?.records)}`;
        case 'found_circular_dependency':
            return `found circular dependency: ${JSON.stringify(d?.toClear)}`;
        case 'record_no_id':
            return `record ${d?.recordId} has no ID, skipping update`;
        case 'updating_record': {
            const records = d?.records || [];
            const typeCounts = formatTypeCounts(d?.recordCountsByType);
            let jsonStr = JSON.stringify(records);
            if (jsonStr.length > 1000) {
                jsonStr = jsonStr.substring(0, 1000) + '...';
            }
            return `updating ${records.length} records (${typeCounts}): ${jsonStr}`;
        }
        case 'error_updating_record':
            return `error updating record ${d?.recordId} of type ${d?.sObjectName}: ${d?.error}`;
        default: {
            const data = typeof d === 'object' ? JSON.stringify(d, null, 2) : d;
            return data ? `${data}\n${event.type}` : event.type;
        }
    }
}

function formatConfirmMigration(d: any): string {
    const lines: string[] = [];
    lines.push('=== Migration Summary ===');
    lines.push('');

    if (d?.source) {
        lines.push(`Source: ${d.source}`);
    }
    if (d?.target) {
        lines.push(`Target: ${d.target}`);
    }
    if (d?.source || d?.target) {
        lines.push('');
    }

    // Collect SObject type counts (top-level numeric properties)
    const typeCounts: Record<string, number> = {};
    for (const key of Object.keys(d || {})) {
        if (key !== 'recordReasons' && key !== 'matchers' && key !== 'source' && key !== 'target' && typeof d[key] === 'number') {
            typeCounts[key] = d[key];
        }
    }

    // Records by type with matcher action
    const matchers: Record<string, { whenMissing: string }> = d?.matchers || {};
    if (Object.keys(typeCounts).length > 0) {
        lines.push('Records to migrate:');
        const total = Object.values(typeCounts).reduce((sum, n) => sum + n, 0);
        const entries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
        const maxTypeLen = Math.max(...entries.map(([k]) => k.length));
        const maxCountLen = Math.max(...entries.map(([, v]) => String(v).length));
        for (const [type, count] of entries) {
            const matcher = matchers[type];
            let action = 'create';
            if (matcher) {
                action = matcher.whenMissing === 'skip' ? 'match or skip' : 'match or create';
            }
            lines.push(`  ${type.padEnd(maxTypeLen)}  ${String(count).padStart(maxCountLen)}  (${action})`);
        }
        lines.push(`  ${'Total'.padEnd(maxTypeLen)}  ${String(total).padStart(maxCountLen)}`);
        lines.push('');
    }

    // Record reasons
    if (d?.recordReasons && Object.keys(d.recordReasons).length > 0) {
        lines.push('Reasons:');
        for (const [reason, typeMap] of Object.entries(d.recordReasons) as [string, Record<string, number>][]) {
            const parts = Object.entries(typeMap).map(([type, count]) => `${count} ${type}`).join(', ');
            lines.push(`  ${reason}: ${parts}`);
        }
        lines.push('');
    }

    lines.push('Do you want to continue? (y/n)');
    return lines.join('\n');
}

function formatFinished(d: any): string {
    let data: any;
    try {
        data = typeof d === 'string' ? JSON.parse(d) : d;
    } catch {
        return 'finished';
    }
    if (!data) return 'finished';

    const lines: string[] = [];
    lines.push('');
    lines.push('=== Migration Complete ===');
    lines.push('');

    // Errors section
    const errors: Record<string, { message: string, fixed: boolean, solver?: { action: string, message: string } }[]> = data.errors || {};
    const allErrors: { recordId: string, message: string, fixed: boolean, solver?: { action: string, message: string } }[] = [];
    for (const [recordId, errs] of Object.entries(errors)) {
        for (const err of errs) {
            allErrors.push({ recordId, ...err });
        }
    }

    if (allErrors.length > 0) {
        lines.push('Errors:');
        for (const err of allErrors) {
            let status: string;
            if (err.fixed) {
                const solverInfo = err.solver ? ` (${err.solver.action}: ${err.solver.message})` : '';
                status = `[fixed${solverInfo}]`;
            } else {
                status = '[unresolved]';
            }
            lines.push(`  ${err.recordId}: ${err.message} ${status}`);
        }
        lines.push('');
    } else {
        lines.push('No errors.');
        lines.push('');
    }

    // Requested records section (at the end for visibility)
    const requestedRecords: Record<string, string> = data.requestedRecords || {};
    if (Object.keys(requestedRecords).length > 0) {
        lines.push('Requested records:');
        const maxIdLen = Math.max(...Object.keys(requestedRecords).map(k => k.length));
        for (const [oldId, newId] of Object.entries(requestedRecords)) {
            lines.push(`  ${oldId.padEnd(maxIdLen)}  ->  ${newId || '(not migrated)'}`);
        }
    }

    return lines.join('\n');
}

function formatTypeCounts(recordCountsByType: Record<string, number> | undefined): string {
    if (!recordCountsByType) return '';
    return Object.entries(recordCountsByType)
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');
}

export function getFormatter(debug: boolean): (event: IOEvent) => string {
    if (debug) {
        return (event: IOEvent) => JSON.stringify(event);
    }
    return formatEvent;
}
