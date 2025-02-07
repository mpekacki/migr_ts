import { ApplicationRunner } from './test-runner';
import { getOrgs } from './sf-cli';

jest.setTimeout(120000);

let application: ApplicationRunner;

beforeEach(async () => {
    application = new ApplicationRunner();
});

test('migrate single record', async () => {
    const { sourceOrg, targetOrg } = await getOrgs();

    const account = await sourceOrg.createAccount();

    await application.runMigration(sourceOrg.alias, targetOrg.alias, account.id!);

    application.showsRecordWasMigrated(account.id!);
});