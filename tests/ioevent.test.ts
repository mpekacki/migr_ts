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
    });
});
