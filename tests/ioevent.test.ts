import IOEvent from '../ioevent';

describe('IOEvent', () => {
    it('should store category, type, and data', () => {
        const event = new IOEvent('output', 'error', { message: 'test' });
        expect(event.category).toBe('output');
        expect(event.type).toBe('error');
        expect(event.data).toEqual({ message: 'test' });
    });

    it('should allow data to be undefined', () => {
        const event = new IOEvent('output', 'aborted');
        expect(event.data).toBeUndefined();
    });

    it('should not have a toString method that formats for display', () => {
        const event = new IOEvent('output', 'error', { message: 'test' });
        // toString should be the default Object.prototype.toString, not a custom formatter
        expect(event.toString()).toBe('[object Object]');
    });
});
