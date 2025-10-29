export type IOEventType = 'confirm_migration' | 'info' | 'insert_error' | 'creating_record' | 'updating_record' | 'using_solver';

class IOEvent {
    constructor(
        public category: 'output' | 'input',
        public message: string,
        public type: IOEventType,
        public data?: any
    ) {}

    toString(): string {
        let data;
        try {
            data = JSON.stringify(this.data, null, 2);
        } catch {
            data = this.data;
        }
        return data ? `${JSON.stringify(data, null, 2)}\n${this.message}` : this.message;
    }
}

export default IOEvent;
