import { ApplicationRunner } from './test-runner';
import { getOrgs } from './sf-cli';

jest.setTimeout(120000);

let application: ApplicationRunner;

beforeEach(async () => {
    application = new ApplicationRunner();
});

test('migrate single record', async () => {
    const { sourceOrg, targetOrg } = await getTestOrgs();

    const account = await sourceOrg.createAccount();

    await application.runMigration(sourceOrg.alias, targetOrg.alias, account.id!);

    const newId = application.showsRecordWasMigrated(account.id!);
    await targetOrg.verifyAccount(newId);
});

const getTestOrgs = async () => {
    return await getOrgs('testMigrationOrgA', 'testMigrationOrgB');
}
