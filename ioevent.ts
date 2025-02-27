class IOEvent {
    constructor(
        public category: 'output' | 'input',
        public message: string, 
        public type: 'confirm_migration' | 'info' | 'insert_error',
        public data?: string
    ) {}

    toString(): string {
        let data;
        try {
            data = JSON.stringify(JSON.parse(this.data!), null, 2);
        } catch {
            data = this.data;
        }
        return data ? `${data}\n${this.message}` : this.message;
    }
}

export default IOEvent;
