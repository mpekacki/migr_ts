import IOEvent from '../ioevent';

describe('IOEvent', () => {
    describe('toString', () => {
        it('should return message when no data is present', () => {
            const event = new IOEvent('output', 'test message', 'info');
            expect(event.toString()).toBe('test message');
        });

        it('should return data and message when data is present', () => {
            const event = new IOEvent('output', 'test message', 'info', 'test data');
            expect(event.toString()).toBe('test data\ntest message');
        });

        it('should pretty print data if it is an object', () => {
            const event = new IOEvent('output', 'test message', 'info', { test: 'data' });
            expect(event.toString()).toBe(`${JSON.stringify({ test: 'data' }, null, 2)}\ntest message`);
        });
    });
});
