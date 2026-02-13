export type IOEventType =
    | 'confirm_migration'
    | 'insert_error'
    | 'creating_record'
    | 'updating_record'
    | 'using_solver'
    | 'saved_records'
    | 'saving_records'
    | 'starting_migration'
    | 'describing_sobject'
    | 'checking_matchers'
    | 'records_so_far'
    | 'fetching_record'
    | 'record_not_found'
    | 'record_not_queryable'
    | 'malformed_id'
    | 'querying_related_records'
    | 'related_records'
    | 'fetched_records'
    | 'aborted'
    | 'confirmation'
    | 'finished'
    | 'remaining_records'
    | 'querying_existing_record'
    | 'found_existing_record'
    | 'skipping_record'
    | 'mapping'
    | 'created_record'
    | 'skipping_previously_used_solvers'
    | 'error'
    | 'saved_old_fields'
    | 'invalid_json'
    | 'invalid_regex'
    | 'invalid_input'
    | 'looking_for_circular_dependencies'
    | 'found_circular_dependency'
    | 'record_no_id'
    | 'error_updating_record'
    | 'progress_bar_init'
    | 'progress_bar_update';

class IOEvent {
    constructor(
        public category: 'output' | 'input',
        public type: IOEventType,
        public data?: any
    ) {}
}

export default IOEvent;
