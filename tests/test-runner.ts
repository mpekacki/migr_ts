import { expect } from '@jest/globals';
import { exec } from 'child_process';
import fs from 'fs';
import { IOEvent } from '../app';

class ApplicationRunner {
    private capturedOutput: IOEvent[] = [];
    private capturedError = '';

    public async runMigration(sourceOrgAlias: string, targetOrgAlias: string, recordId: string) {
        const config = {
            sourceOrg: sourceOrgAlias,
            targetOrg: targetOrgAlias,
            recordIds: [recordId],
            matchers: [
                {
                    sObjectType: 'Profile',
                    fieldMappings: [
                        { sourceField: 'Name', targetField: 'Name' }
                    ]
                },
                {
                    sObjectType: 'User',
                    fieldMappings: [
                        { sourceField: 'Name', targetField: 'Name' }
                    ]
                },
                {
                    sObjectType: 'UserRole',
                    fieldMappings: [
                        { sourceField: 'Name', targetField: 'Name' }
                    ]
                },
                {
                    sObjectType: 'UserLicense',
                    fieldMappings: [
                        { sourceField: 'Name', targetField: 'Name' }
                    ]
                }
            ]
        };
        fs.writeFileSync('./config_test.json', JSON.stringify(config, null, 2));

        const inputHandler = ['y'];

        const child = exec(`npx ts-node ./main.ts --config-json ./config_test.json --debug`);

        child.stdout?.on('data', (data) => {
            console.log(data);
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.trim() === '') {
                    continue;
                }
                const event = JSON.parse(line) as IOEvent;
                this.capturedOutput.push(event);
                if (event.category === 'input') {
                    const input = inputHandler.shift();
                    expect(input).toBeDefined();

                    if (!input) {
                        child.stdin?.end();
                        return;
                    }
                    console.log(`sending input: ${input}`);
                    child.stdin?.write(input);
                    child.stdin?.write('\n');

                }
            }
        });
        child.stderr?.on('data', (data) => {
            console.error(data);
            this.capturedError += data;
        });
        await new Promise(resolve => child.on('close', resolve));

        expect(this.capturedError).toBe('');
        expect(this.capturedOutput.length).toBeGreaterThan(1);
    }

    public showsRecordWasMigrated(recordId: string) {
        const parsedOutput = JSON.parse(this.capturedOutput[this.capturedOutput.length - 1].data!);
        expect(parsedOutput).toHaveProperty(recordId);
        expect(parsedOutput[recordId]).toBeTruthy();
        expect(parsedOutput[recordId]).not.toEqual(recordId);
    }
}




export { ApplicationRunner };