class IOEvent {
    constructor(
        public category: 'output' | 'input',
        public message: string, 
        public type: 'confirm_migration' | 'info' | 'insert_error',
        public data?: string
    ) {}

    toString(): string {
        return this.data ? `${this.data}\n${this.message}` : this.message;
    }
}

export default IOEvent;
