export type IOEventType = 'confirm_migration' | 'info' | 'insert_error' | 'creating_record' | 'updating_record' | 'using_solver' | 'saved_records';

class IOEvent {
    constructor(
        public category: 'output' | 'input',
        public message: string,
        public type: IOEventType,
        public data?: any
    ) {}

    toString(): string {
        let data = this.data;
        if (typeof data === 'object') {
            data = JSON.stringify(data, null, 2);
        }
        return data ? `${data}\n${this.message}` : this.message;
    }
}

export default IOEvent;
